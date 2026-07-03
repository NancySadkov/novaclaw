#!/usr/bin/env bun
// KB-C decision gate #1 — can qwen3.6-35b author correct queries in Datalog vs SPARQL vs SQL?
//
// rag.md's biggest untested assumption (zero published evidence for logic-language authoring by
// 7-35B models). This eval answers it EMPIRICALLY on a controlled schema: the same fictional
// rockfacts triples are exposed three ways, qwen authors a query per question per language, and
// each query is EXECUTED against identical data — so the only variable is authoring accuracy.
//
// Engines are minimal but correct for the conjunctive subset the questions need (1-hop lookups +
// multi-pattern joins). SQL runs on real bun:sqlite; Datalog + SPARQL run on a shared triple-join
// core (BGP = conjunctive query). No JVM, no Datalevin — this is the GATE before that integration.
//
// Usage:  bun script/kb/query-eval.ts [--n 30] [--vllm http://192.168.178.40:8000/v1] [--model qwen3.6-35b]
//         [--facts rockfacts.jsonl] [--out eval-results.json]
// If --facts is omitted it generates the rockfacts universe in-process.

import { Database } from "bun:sqlite"

interface Triple {
  s: string
  p: string
  o: string
}

const args = new Map<string, string>()
for (let i = 2; i < Bun.argv.length; i += 2) {
  const key = Bun.argv[i]
  if (key?.startsWith("--")) args.set(key.slice(2), Bun.argv[i + 1] ?? "")
}
const N = Number(args.get("n") ?? 30)
const VLLM = (args.get("vllm") ?? "http://192.168.178.40:8000/v1").replace(/\/$/, "")
const MODEL = args.get("model") ?? "qwen3.6-35b"

// ── facts ────────────────────────────────────────────────────────────────────────────────
async function loadFacts(): Promise<Triple[]> {
  const file = args.get("facts")
  if (file) {
    const text = await Bun.file(file).text()
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { subject: string; predicate: string; object: string })
      .map((f) => ({ s: f.subject, p: f.predicate, o: f.object }))
  }
  // Generate in-process (mirror of generate-rockfacts, seed-locked, smaller).
  const gen = Bun.spawnSync(
    ["bun", new URL("./generate-rockfacts.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--out", "/dev/stdout", "--bands", "60"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const out = gen.stdout.toString()
  const jsonLines = out.split("\n").filter((l) => l.startsWith("{"))
  return jsonLines.map((line) => {
    const f = JSON.parse(line) as { subject: string; predicate: string; object: string }
    return { s: f.subject, p: f.predicate, o: f.object }
  })
}

// ── the shared conjunctive-join core (Datalog body = SPARQL BGP = list of triple patterns) ──
type Term = { kind: "var"; name: string } | { kind: "const"; value: string }
interface Pattern {
  s: Term
  p: Term
  o: Term
}

function joinBGP(triples: Triple[], patterns: Pattern[], selectVars: string[]): string[][] {
  // Index by predicate for speed on the larger sets.
  const byPredicate = new Map<string, Triple[]>()
  for (const t of triples) {
    const list = byPredicate.get(t.p) ?? []
    list.push(t)
    byPredicate.set(t.p, list)
  }
  let bindings: Array<Record<string, string>> = [{}]
  for (const pattern of patterns) {
    const candidates = pattern.p.kind === "const" ? (byPredicate.get(pattern.p.value) ?? []) : triples
    const next: Array<Record<string, string>> = []
    for (const binding of bindings) {
      for (const triple of candidates) {
        const attempt = { ...binding }
        if (!unify(pattern.s, triple.s, attempt)) continue
        if (!unify(pattern.p, triple.p, attempt)) continue
        if (!unify(pattern.o, triple.o, attempt)) continue
        next.push(attempt)
      }
    }
    bindings = next
  }
  const seen = new Set<string>()
  const rows: string[][] = []
  for (const binding of bindings) {
    const row = selectVars.map((v) => binding[v] ?? "")
    const key = row.join("\x00")
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  return rows
}

function unify(term: Term, value: string, binding: Record<string, string>): boolean {
  if (term.kind === "const") return term.value === value
  if (binding[term.name] === undefined) {
    binding[term.name] = value
    return true
  }
  return binding[term.name] === value
}

// ── SQL engine (real SQLite) ────────────────────────────────────────────────────────────
function makeSqlDb(triples: Triple[]): Database {
  const db = new Database(":memory:")
  db.run("CREATE TABLE fact (subject TEXT, predicate TEXT, object TEXT)")
  const insert = db.prepare("INSERT INTO fact (subject, predicate, object) VALUES (?, ?, ?)")
  const tx = db.transaction((rows: Triple[]) => {
    for (const t of rows) insert.run(t.s, t.p, t.o)
  })
  tx(triples)
  db.run("CREATE INDEX idx_sp ON fact(subject, predicate)")
  db.run("CREATE INDEX idx_po ON fact(predicate, object)")
  return db
}

function runSql(db: Database, query: string): string[] {
  // Read-only guard: allow a single SELECT (optionally a leading CTE); reject multi-statement.
  const trimmed = query.replace(/;\s*$/, "").trim()
  if (!/^\s*(with|select)\b/i.test(trimmed) || /;\s*\S/.test(trimmed)) throw new Error("not a single SELECT")
  const rows = db.query(trimmed).values() as unknown[][]
  // Flatten all columns (the answer may not be column 0 in a multi-select join).
  return rows.flatMap((row) => row.map((cell) => String(cell ?? ""))).filter(Boolean)
}

// Split a comma-separated argument list, respecting quoted strings (commas inside quotes stay).
function splitArgs(inner: string): string[] {
  const args: string[] = []
  let current = ""
  let quote: string | undefined
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ",") {
      args.push(current)
      current = ""
    } else current += ch
  }
  if (current.trim()) args.push(current)
  return args.map((a) => a.trim())
}

// ── Datalog parser (conjunctive query: `?- p1, p2, ... .` with fact/3 literals) ───────────
// Accept forms: fact(S, "member_of", Band)  — uppercase/`_`-leading = var, quoted = const.
function parseDatalog(query: string): { patterns: Pattern[]; select: string[] } {
  const body = query.replace(/^\s*\?-/, "").replace(/\.\s*$/, "").trim()
  const literals = body.match(/fact\s*\(([^)]*)\)/gi) ?? []
  const patterns: Pattern[] = []
  const varsInOrder: string[] = []
  for (const literal of literals) {
    const inner = /\(([^)]*)\)/.exec(literal)![1]!
    const parts = splitArgs(inner)
    if (parts.length !== 3) continue
    const terms = parts.map((raw) => toTerm(raw, varsInOrder))
    patterns.push({ s: terms[0]!, p: terms[1]!, o: terms[2]! })
  }
  // Select vars = the query's distinguished vars (all vars, ordered by first appearance).
  return { patterns, select: [...new Set(varsInOrder)] }
}

function toTerm(raw: string, varsInOrder: string[]): Term {
  const value = raw.trim()
  const quoted = /^["'](.*)["']$/.exec(value)
  if (quoted) return { kind: "const", value: quoted[1]! }
  // Datalog convention: Var starts uppercase or _ ; lowercase bareword = const (rare here).
  if (/^[A-Z_]/.test(value)) {
    varsInOrder.push(value)
    return { kind: "var", name: value }
  }
  return { kind: "const", value }
}

// ── SPARQL parser (SELECT ?v WHERE { s p o . s p o . }) ───────────────────────────────────
function parseSparql(query: string): { patterns: Pattern[]; select: string[] } {
  const selectMatch = /select\s+(distinct\s+)?(.+?)\s+where/is.exec(query)
  const projected = selectMatch ? selectMatch[2]!.trim() : "*"
  const whereMatch = /\{([\s\S]*)\}/.exec(query)
  const inner = whereMatch ? whereMatch[1]! : ""
  const patterns: Pattern[] = []
  for (const stmt of inner.split(/\.\s*(?=\S|$)/)) {
    const tokens = tokenizeSparqlTriple(stmt.trim())
    if (tokens.length !== 3) continue
    patterns.push({ s: sparqlTerm(tokens[0]!), p: sparqlTerm(tokens[1]!), o: sparqlTerm(tokens[2]!) })
  }
  const select =
    projected === "*"
      ? [...new Set(patterns.flatMap((p) => [p.s, p.p, p.o]).filter((t) => t.kind === "var").map((t) => (t as { name: string }).name))]
      : (projected.match(/\?(\w+)/g) ?? []).map((v) => v.slice(1))
  return { patterns, select }
}

function tokenizeSparqlTriple(stmt: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < stmt.length) {
    while (stmt[i] === " " || stmt[i] === "\t" || stmt[i] === "\n") i++
    if (i >= stmt.length) break
    if (stmt[i] === '"') {
      const end = stmt.indexOf('"', i + 1)
      tokens.push(stmt.slice(i, end + 1))
      i = end + 1
    } else if (stmt[i] === "<") {
      const end = stmt.indexOf(">", i)
      tokens.push(stmt.slice(i, end + 1))
      i = end + 1
    } else {
      let end = i
      while (end < stmt.length && !/\s/.test(stmt[end]!)) end++
      tokens.push(stmt.slice(i, end))
      i = end
    }
  }
  return tokens
}

function sparqlTerm(token: string): Term {
  if (token.startsWith("?") || token.startsWith("$")) return { kind: "var", name: token.slice(1) }
  const quoted = /^"(.*)"$/.exec(token)
  if (quoted) return { kind: "const", value: quoted[1]! }
  const iri = /^<(.*)>$/.exec(token)
  if (iri) {
    // Our triples use bare slug/name values as IRIs: <the-velvet-corvids> or ns:member_of.
    const inner = iri[1]!
    return { kind: "const", value: inner.split(/[/#:]/).pop() || inner }
  }
  // prefixed name ns:member_of → local part
  if (token.includes(":")) return { kind: "const", value: token.split(":").pop()! }
  return { kind: "const", value: token }
}

// ── question generation from the schema (1-hop + 2-hop joins) ─────────────────────────────
interface Question {
  text: string
  answers: string[]
  hops: 1 | 2
}

function buildQuestions(triples: Triple[]): Question[] {
  const byS = new Map<string, Triple[]>()
  for (const t of triples) {
    const list = byS.get(t.s) ?? []
    list.push(t)
    byS.set(t.s, list)
  }
  const get = (s: string, p: string) => byS.get(s)?.find((t) => t.p === p)?.o
  const musicians = triples.filter((t) => t.p === "type" && t.o === "musician").map((t) => t.s)
  const bands = triples.filter((t) => t.p === "type" && t.o === "band").map((t) => t.s)
  const questions: Question[] = []

  // 1-hop: a musician's band, a band's city / founding year.
  for (const m of musicians) {
    const name = get(m, "name")
    const band = get(m, "member_of")
    if (name && band) questions.push({ text: `Which band is the musician "${name}" a member of?`, answers: [band], hops: 1 })
  }
  for (const b of bands) {
    const name = get(b, "name")
    const city = get(b, "origin_city")
    const founded = get(b, "founded_in")
    if (name && city) questions.push({ text: `In which city was the band "${name}" formed?`, answers: [city], hops: 1 })
    if (name && founded) questions.push({ text: `In which year was the band "${name}" founded?`, answers: [founded], hops: 1 })
  }

  // 2-hop join: the founding city of the band a given musician plays in (member_of is a NAME,
  // so it joins through the band's `name` fact to the band slug → origin_city).
  for (const m of musicians) {
    const name = get(m, "name")
    const bandName = get(m, "member_of")
    const bandSlug = bands.find((b) => get(b, "name") === bandName)
    const city = bandSlug ? get(bandSlug, "origin_city") : undefined
    // Unambiguous 2-hop: "origin_city" only (avoid "formed" which reads as founded_in/year).
    if (name && city)
      questions.push({ text: `What is the origin_city of the band that "${name}" is a member of?`, answers: [city], hops: 2 })
  }
  return questions
}

// ── prompts (schema + question → a query in each language) ────────────────────────────────
const SCHEMA_NOTE = `The knowledge base is a set of (subject, predicate, object) triples about a fictional rock-music world.
Subjects are lowercase-hyphen SLUGS ("The Velvet Corvids" -> "the-velvet-corvids", "Korvath Dreyne" -> "korvath-dreyne").
Predicates: name, type (band|musician|album), genre, founded_in, origin_city, record_label, disbanded_in, member_of, role, born_in, album_by, released_in.
IMPORTANT joins: member_of and album_by store the band's DISPLAY NAME (not a slug); to reach a band's other facts, join through the band's (slug, "name", DisplayName) triple.`

const PROMPTS: Record<string, (q: string) => string> = {
  sql: (q) =>
    `${SCHEMA_NOTE}\nThe triples are in a SQLite table:  fact(subject TEXT, predicate TEXT, object TEXT).\nWrite ONE SQL SELECT that returns the answer to this question in its FIRST column. Output ONLY the SQL, no explanation, no markdown fences.\nQuestion: ${q}`,
  datalog: (q) =>
    `${SCHEMA_NOTE}\nThe triples are the relation fact/3:  fact(Subject, Predicate, Object).\nWrite ONE Datalog conjunctive query of the form  ?- fact(...), fact(...), ... .  Use quoted strings for constants and Uppercase names for variables. The answer must be bound to a variable in the query. Output ONLY the query line, no explanation.\nQuestion: ${q}`,
  sparql: (q) =>
    `${SCHEMA_NOTE}\nThe triples are RDF:  subject/predicate/object are IRIs written as <slug-or-value> and <predicate>; string values also as <value>.\nWrite ONE SPARQL query:  SELECT ?answer WHERE { <s> <p> ?x . ... }  binding the answer to a projected variable. Output ONLY the SPARQL, no explanation, no markdown fences.\nQuestion: ${q}`,
}

function stripFences(text: string): string {
  const fence = /```(?:sql|sparql|datalog|prolog)?\s*([\s\S]*?)```/i.exec(text)
  return (fence ? fence[1]! : text).trim()
}

async function authorQuery(language: string, question: string): Promise<string> {
  const res = await fetch(`${VLLM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 2048,
      messages: [{ role: "user", content: PROMPTS[language]!(question) }],
    }),
  }).then((r) => r.json()).catch(() => undefined)
  return stripFences((res as any)?.choices?.[0]?.message?.content ?? "")
}

const norm = (s: string) => s.trim().toLowerCase()
function correct(got: string[], answers: string[]): boolean {
  const gotSet = new Set(got.map(norm))
  return answers.every((a) => gotSet.has(norm(a))) && got.length > 0
}

// ── run ──────────────────────────────────────────────────────────────────────────────────
if (!(await fetch(`${VLLM}/models`).then((r) => r.ok).catch(() => false))) {
  console.error("model backend not reachable at " + VLLM)
  process.exit(1)
}
const triples = await loadFacts()
console.log(`loaded ${triples.length} triples`)
const sqlDb = makeSqlDb(triples)
const allQuestions = buildQuestions(triples)
// Deterministic spread across 1-hop and 2-hop.
const oneHop = allQuestions.filter((q) => q.hops === 1)
const twoHop = allQuestions.filter((q) => q.hops === 2)
const pickEvery = <T>(xs: T[], k: number) => (xs.length <= k ? xs : xs.filter((_, i) => i % Math.floor(xs.length / k) === 0).slice(0, k))
const questions = [...pickEvery(oneHop, Math.ceil(N * 0.6)), ...pickEvery(twoHop, Math.floor(N * 0.4))]
console.log(`evaluating ${questions.length} questions (${questions.filter((q) => q.hops === 1).length} 1-hop, ${questions.filter((q) => q.hops === 2).length} 2-hop) × 3 languages\n`)

const languages = ["sql", "datalog", "sparql"] as const
const score: Record<string, { ok: number; total: number; ok1: number; total1: number; ok2: number; total2: number; errors: number }> = {}
for (const lang of languages) score[lang] = { ok: 0, total: 0, ok1: 0, total1: 0, ok2: 0, total2: 0, errors: 0 }
const samples: any[] = []

for (const question of questions) {
  const record: any = { q: question.text, hops: question.hops, answers: question.answers }
  for (const lang of languages) {
    const query = await authorQuery(lang, question.text)
    let got: string[] = []
    let error: string | undefined
    try {
      if (lang === "sql") got = runSql(sqlDb, query)
      else {
        const parsed = lang === "datalog" ? parseDatalog(query) : parseSparql(query)
        if (parsed.patterns.length === 0) throw new Error("no patterns parsed")
        const selectVar = parsed.select[parsed.select.length - 1] ? [parsed.select[parsed.select.length - 1]!] : parsed.select
        // Answer var = the LAST distinguished variable (the one the question asks for); for
        // multi-var conjunctive queries the unknown is typically introduced last.
        const rows = joinBGP(triples, parsed.patterns, parsed.select.length ? parsed.select : selectVar)
        // Match answer against ANY column (the model may project extra join vars).
        got = rows.flat().filter(Boolean)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      score[lang]!.errors++
    }
    const ok = !error && correct(got, question.answers)
    const s = score[lang]!
    s.total++
    if (ok) s.ok++
    if (question.hops === 1) {
      s.total1++
      if (ok) s.ok1++
    } else {
      s.total2++
      if (ok) s.ok2++
    }
    record[lang] = { query: query.slice(0, 200), got: got.slice(0, 5), ok, error }
  }
  samples.push(record)
  process.stdout.write(".")
}
console.log("\n")

const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(0).padStart(3)}%`)
console.log("language   overall     1-hop     2-hop   parse-errors")
for (const lang of languages) {
  const s = score[lang]!
  console.log(
    `${lang.padEnd(9)}  ${pct(s.ok, s.total)} (${s.ok}/${s.total})   ${pct(s.ok1, s.total1)}   ${pct(s.ok2, s.total2)}   ${s.errors}`,
  )
}

const outFile = args.get("out")
if (outFile) {
  await Bun.write(outFile, JSON.stringify({ model: MODEL, triples: triples.length, score, samples }, null, 2))
  console.log(`\nfull results → ${outFile}`)
}

// Verdict line for the KB-C gate.
const best = languages.reduce((a, b) => (score[b]!.ok / score[b]!.total > score[a]!.ok / score[a]!.total ? b : a))
console.log(
  `\nKB-C gate #1 verdict: best surface for qwen = ${best} (${pct(score[best]!.ok, score[best]!.total)}). ` +
    `Datalog vs SQL gap = ${(((score.sql!.ok - score.datalog!.ok) / score.sql!.total) * 100).toFixed(0)} pts.`,
)
