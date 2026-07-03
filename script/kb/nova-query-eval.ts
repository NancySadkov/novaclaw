#!/usr/bin/env bun
// Head-to-head: an LLM-NATIVE JSON query DSL vs SPARQL (the human-language winner, 75%).
//
// Thesis (from KB-C gate #1): the model shouldn't AUTHOR SPARQL text — it should author a JSON
// INTENT the engine executes. That (a) removes the syntax-error class (a tool call is
// schema-validated, and vLLM guided_json makes invalid output impossible), and (b) hides the
// id/slug join behind LABEL RESOLUTION, which is what killed every human language on 2-hop.
//
// Three arms on the SAME questions:
//   nova         — the JSON DSL, unconstrained (qwen emits JSON free-form; we parse+repair).
//   nova-guided  — the JSON DSL with vLLM guided_json (output is always schema-valid — the real
//                  tool-call deployment: syntax errors are impossible).
//   sparql       — the incumbent, for a direct comparison.
//
// Usage:  bun script/kb/nova-query-eval.ts --n 24 --facts rockfacts.jsonl --out nova-eval.json

interface Triple { s: string; p: string; o: string }

const args = new Map<string, string>()
for (let i = 2; i < Bun.argv.length; i += 2) {
  const k = Bun.argv[i]
  if (k?.startsWith("--")) args.set(k.slice(2), Bun.argv[i + 1] ?? "")
}
const N = Number(args.get("n") ?? 24)
const VLLM = (args.get("vllm") ?? "http://192.168.178.40:8000/v1").replace(/\/$/, "")
const MODEL = args.get("model") ?? "qwen3.6-35b"

async function loadFacts(): Promise<Triple[]> {
  const file = args.get("facts")!
  const text = await Bun.file(file).text()
  return text.trim().split("\n").map((l) => {
    const f = JSON.parse(l) as { subject: string; predicate: string; object: string }
    return { s: f.subject, p: f.predicate, o: f.object }
  })
}

const triples = await loadFacts()
// Label index: display name -> slug (from `(slug,"name",Name)`), for entity-by-label resolution.
const nameToSlug = new Map<string, string>()
const slugSet = new Set<string>()
for (const t of triples) {
  slugSet.add(t.s)
  if (t.p === "name") nameToSlug.set(t.o.toLowerCase(), t.s)
}
// Resolve a value used as a SUBJECT to its canonical slug: pass slugs through; map names -> slug.
// This is the trick that hides the name->slug indirection the model shouldn't have to author.
function toSubject(value: string): string {
  if (slugSet.has(value)) return value
  const bySlug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (slugSet.has(bySlug)) return bySlug
  return nameToSlug.get(value.toLowerCase()) ?? value
}

// ── the DSL executor ──────────────────────────────────────────────────────────────────────
const byS = new Map<string, Triple[]>()
for (const t of triples) {
  const l = byS.get(t.s) ?? []
  l.push(t)
  byS.set(t.s, l)
}
const factsOf = (subj: string) => byS.get(toSubject(subj)) ?? []

type Pattern = [string, string, string]
const isVar = (t: string) => typeof t === "string" && t.startsWith("?")

// Conjunctive match with LABEL-AWARE subject resolution: a bound/const subject that is a name
// resolves to its slug before matching, so multi-hop joins through name->slug just work.
function runMatch(where: Pattern[], find: string[], limit = 100): string[] {
  let bindings: Array<Record<string, string>> = [{}]
  for (const [ps, pp, po] of where) {
    const next: Array<Record<string, string>> = []
    for (const b of bindings) {
      const subjVal = isVar(ps) ? b[ps] : ps
      const candidates = subjVal !== undefined ? factsOf(subjVal) : triples
      for (const t of candidates) {
        const nb = { ...b }
        if (!unify(ps, t.s, nb, true)) continue
        if (!unify(pp, t.p, nb, false)) continue
        if (!unify(po, t.o, nb, false)) continue
        next.push(nb)
      }
    }
    bindings = next
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const b of bindings) {
    for (const v of find.length ? find : Object.keys(b)) {
      const val = b[v]
      if (val && !seen.has(v + "\x00" + val)) {
        seen.add(v + "\x00" + val)
        out.push(val)
      }
    }
    if (out.length >= limit) break
  }
  return out
}
function unify(term: string, value: string, b: Record<string, string>, subjectPos: boolean): boolean {
  if (isVar(term)) {
    if (b[term] === undefined) {
      b[term] = value
      return true
    }
    return subjectPos ? toSubject(b[term]) === toSubject(value) : b[term] === value
  }
  return subjectPos ? toSubject(term) === toSubject(value) : term === value
}

interface NovaQuery {
  op: "match" | "neighbors" | "get" | "count"
  find?: string[]
  where?: Pattern[]
  entity?: string
  predicate?: string
  direction?: "out" | "in"
  limit?: number
}

function execNova(q: NovaQuery): string[] {
  switch (q.op) {
    case "get":
      return factsOf(q.entity ?? "").map((t) => `${t.p}: ${t.o}`)
    case "neighbors": {
      const dir = q.direction ?? "out"
      if (dir === "in")
        return triples.filter((t) => t.p === q.predicate && toSubject(t.o) === toSubject(q.entity ?? "")).map((t) => t.s)
      return factsOf(q.entity ?? "").filter((t) => !q.predicate || t.p === q.predicate).map((t) => t.o)
    }
    case "count":
      return [String(new Set(runMatch(q.where ?? [], q.find ?? [], 100000)).size)]
    case "match":
    default:
      return runMatch(q.where ?? [], q.find ?? [], q.limit ?? 100)
  }
}

// JSON schema for guided_json (discriminated by `op`; xgrammar handles the union).
const NOVA_SCHEMA = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["match", "neighbors", "get", "count"] },
    find: { type: "array", items: { type: "string" } },
    where: { type: "array", items: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } },
    entity: { type: "string" },
    predicate: { type: "string" },
    direction: { type: "string", enum: ["out", "in"] },
    limit: { type: "integer" },
  },
  required: ["op"],
  additionalProperties: false,
}

// ── question generation (same schema as query-eval.ts: 1-hop + 2-hop name->slug joins) ──────
interface Question { text: string; answers: string[]; hops: 1 | 2 }
function buildQuestions(): Question[] {
  const get = (s: string, p: string) => byS.get(s)?.find((t) => t.p === p)?.o
  const musicians = triples.filter((t) => t.p === "type" && t.o === "musician").map((t) => t.s)
  const bands = triples.filter((t) => t.p === "type" && t.o === "band").map((t) => t.s)
  const qs: Question[] = []
  for (const m of musicians) {
    const name = get(m, "name")
    const band = get(m, "member_of")
    if (name && band) qs.push({ text: `Which band is the musician "${name}" a member of?`, answers: [band], hops: 1 })
  }
  for (const b of bands) {
    const name = get(b, "name")
    const city = get(b, "origin_city")
    const founded = get(b, "founded_in")
    if (name && city) qs.push({ text: `In which city was the band "${name}" formed?`, answers: [city], hops: 1 })
    if (name && founded) qs.push({ text: `In which year was the band "${name}" founded?`, answers: [founded], hops: 1 })
  }
  for (const m of musicians) {
    const name = get(m, "name")
    const bandName = get(m, "member_of")
    const bandSlug = bands.find((b) => get(b, "name") === bandName)
    const city = bandSlug ? get(bandSlug, "origin_city") : undefined
    if (name && city)
      qs.push({ text: `What is the origin_city of the band that "${name}" is a member of?`, answers: [city], hops: 2 })
  }
  return qs
}

const SCHEMA_NOTE = `A knowledge base of (subject, predicate, object) triples about a fictional rock-music world.
Predicates: name, type (band|musician|album), genre, founded_in, origin_city, record_label, disbanded_in, member_of, role, born_in, album_by, released_in.
You refer to entities by their DISPLAY NAME (e.g. "The Velvet Corvids", "Korvath Dreyne") — the engine resolves names to ids and hides all id/join plumbing. member_of and album_by give a band's NAME; you can use that name directly as the subject of another pattern (the engine follows it).`

const NOVA_MANUAL = `${SCHEMA_NOTE}
Answer by emitting ONE JSON query (no prose). Operations:
- {"op":"neighbors","entity":NAME,"predicate":PRED}          -> the objects of NAME's PRED facts (one hop).
- {"op":"get","entity":NAME}                                  -> all "predicate: value" facts about NAME.
- {"op":"match","find":["?x"],"where":[[S,P,O],...]}          -> conjunctive pattern match. Terms are a NAME/value
    or a "?var". Bind the ANSWER to a ?var and list it in "find". Chain patterns to join
    (e.g. [["Korvath Dreyne","member_of","?band"],["?band","origin_city","?city"]] with find ["?city"]).
- {"op":"count","where":[...]}                                -> how many matches.`

const PROMPTS = {
  nova: (q: string) => `${NOVA_MANUAL}\nQuestion: ${q}\nJSON query:`,
  "nova-guided": (q: string) => `${NOVA_MANUAL}\nQuestion: ${q}\nJSON query:`,
  sparql: (q: string) =>
    `${SCHEMA_NOTE}\nThe triples are RDF: subject/predicate/object are IRIs <slug-or-value>. Write ONE SPARQL SELECT binding the answer to a projected variable. Output ONLY the SPARQL.\nQuestion: ${q}`,
}

// ── SPARQL executor (minimal BGP, copied from query-eval.ts, with label-aware subjects) ─────
function parseSparql(query: string): { patterns: Pattern[]; select: string[] } {
  const sel = /select\s+(distinct\s+)?(.+?)\s+where/is.exec(query)
  const projected = sel ? sel[2]!.trim() : "*"
  const inner = /\{([\s\S]*)\}/.exec(query)?.[1] ?? ""
  const patterns: Pattern[] = []
  for (const stmt of inner.split(/\.\s*(?=\S|$)/)) {
    const toks = tokenizeTriple(stmt.trim())
    if (toks.length === 3) patterns.push([spTerm(toks[0]!), spTerm(toks[1]!), spTerm(toks[2]!)])
  }
  const select =
    projected === "*"
      ? [...new Set(patterns.flat().filter(isVar))]
      : (projected.match(/\?(\w+)/g) ?? []).map((v) => v)
  return { patterns, select }
}
function tokenizeTriple(stmt: string): string[] {
  const toks: string[] = []
  let i = 0
  while (i < stmt.length) {
    while (/\s/.test(stmt[i]!)) i++
    if (i >= stmt.length) break
    if (stmt[i] === '"') {
      const e = stmt.indexOf('"', i + 1)
      toks.push(stmt.slice(i, e + 1))
      i = e + 1
    } else if (stmt[i] === "<") {
      const e = stmt.indexOf(">", i)
      toks.push(stmt.slice(i, e + 1))
      i = e + 1
    } else {
      let e = i
      while (e < stmt.length && !/\s/.test(stmt[e]!)) e++
      toks.push(stmt.slice(i, e))
      i = e
    }
  }
  return toks
}
function spTerm(t: string): string {
  if (t.startsWith("?") || t.startsWith("$")) return "?" + t.slice(1).replace(/[^\w]/g, "")
  const iri = /^<(.*)>$/.exec(t)
  if (iri) return iri[1]!.split(/[/#:]/).pop() || iri[1]!
  const q = /^"(.*)"$/.exec(t)
  if (q) return q[1]!
  if (t.includes(":")) return t.split(":").pop()!
  return t
}

// All arms run in the realistic "quick tool-call" regime: NO deep reasoning (a query is a
// mechanical translation, not a reasoning task) — same condition for every arm, and fast.
const NO_THINK = { enable_thinking: false }
async function authorNova(question: string, guided: boolean): Promise<{ query: string }> {
  const body: any = {
    model: MODEL,
    temperature: 0,
    max_tokens: 512,
    chat_template_kwargs: NO_THINK,
    messages: [{ role: "user", content: PROMPTS[guided ? "nova-guided" : "nova"](question) }],
  }
  if (guided) body.guided_json = NOVA_SCHEMA // vLLM/xgrammar: output constrained to the schema
  const res = await fetch(`${VLLM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => undefined)
  return { query: (res as any)?.choices?.[0]?.message?.content ?? "" }
}
async function authorSparql(question: string): Promise<string> {
  const res = await fetch(`${VLLM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 512,
      chat_template_kwargs: NO_THINK,
      messages: [{ role: "user", content: PROMPTS.sparql(question) }],
    }),
  }).then((r) => r.json()).catch(() => undefined)
  const text = (res as any)?.choices?.[0]?.message?.content ?? ""
  const fence = /```(?:sparql)?\s*([\s\S]*?)```/i.exec(text)
  return (fence ? fence[1]! : text).trim()
}

function extractJson(text: string): NovaQuery | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fence ? fence[1]! : text).trim()
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end < 0) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1)) as NovaQuery
  } catch {
    return undefined
  }
}

const norm = (s: string) => s.trim().toLowerCase()
const correct = (got: string[], answers: string[]) => {
  const set = new Set(got.map(norm))
  return got.length > 0 && answers.every((a) => set.has(norm(a)))
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
if (!(await fetch(`${VLLM}/models`).then((r) => r.ok).catch(() => false))) {
  console.error("model backend not reachable at " + VLLM)
  process.exit(1)
}
console.log(`loaded ${triples.length} triples`)
const all = buildQuestions()
const oneHop = all.filter((q) => q.hops === 1)
const twoHop = all.filter((q) => q.hops === 2)
const pick = <T>(xs: T[], k: number) => (xs.length <= k ? xs : xs.filter((_, i) => i % Math.floor(xs.length / k) === 0).slice(0, k))
const questions = [...pick(oneHop, Math.ceil(N * 0.6)), ...pick(twoHop, Math.floor(N * 0.4))]
console.log(`evaluating ${questions.length} questions (${questions.filter((q) => q.hops === 1).length} 1-hop, ${questions.filter((q) => q.hops === 2).length} 2-hop) × 3 arms\n`)

const arms = ["nova", "nova-guided", "sparql"] as const
const score: Record<string, { ok: number; total: number; ok1: number; t1: number; ok2: number; t2: number; err: number }> = {}
for (const a of arms) score[a] = { ok: 0, total: 0, ok1: 0, t1: 0, ok2: 0, t2: 0, err: 0 }
const samples: any[] = []

for (const question of questions) {
  const rec: any = { q: question.text, hops: question.hops, answers: question.answers }
  for (const arm of arms) {
    let got: string[] = []
    let error: string | undefined
    let raw = ""
    try {
      if (arm === "sparql") {
        raw = await authorSparql(question.text)
        const { patterns, select } = parseSparql(raw)
        if (patterns.length === 0) throw new Error("no patterns")
        got = runMatch(patterns as Pattern[], select)
      } else {
        const { query } = await authorNova(question.text, arm === "nova-guided")
        raw = query
        const parsed = extractJson(query)
        if (!parsed || !parsed.op) throw new Error("json parse")
        got = execNova(parsed)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      score[arm]!.err++
    }
    const ok = !error && correct(got, question.answers)
    const s = score[arm]!
    s.total++
    if (ok) s.ok++
    if (question.hops === 1) {
      s.t1++
      if (ok) s.ok1++
    } else {
      s.t2++
      if (ok) s.ok2++
    }
    rec[arm] = { raw: raw.slice(0, 160), got: got.slice(0, 4), ok, error }
  }
  samples.push(rec)
  process.stdout.write(".")
}
console.log("\n")

const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(0).padStart(3)}%`)
console.log("arm           overall     1-hop     2-hop   parse-errors")
for (const arm of arms) {
  const s = score[arm]!
  console.log(`${arm.padEnd(12)}  ${pct(s.ok, s.total)} (${s.ok}/${s.total})   ${pct(s.ok1, s.t1)}   ${pct(s.ok2, s.t2)}   ${s.err}`)
}

const out = args.get("out")
if (out) {
  await Bun.write(out, JSON.stringify({ model: MODEL, triples: triples.length, score, samples }, null, 2))
  console.log(`\nfull results -> ${out}`)
}
const nova = score["nova-guided"]!
const sp = score["sparql"]!
console.log(
  `\nVerdict: nova-guided ${pct(nova.ok, nova.total)} vs sparql ${pct(sp.ok, sp.total)} — ` +
    `the JSON-intent DSL ${nova.ok > sp.ok ? "BEATS" : nova.ok === sp.ok ? "ties" : "trails"} SPARQL ` +
    `(2-hop: ${pct(nova.ok2, nova.t2)} vs ${pct(sp.ok2, sp.t2)}).`,
)
