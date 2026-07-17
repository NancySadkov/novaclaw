#!/usr/bin/env bun
// kb-tool-eval.ts — KB-E phase 3, the ENGINE-side regression gate (no LLM).
//
// nova-query-eval.ts measures the CONCEPT (qwen authoring the JSON DSL via raw vLLM); its
// residual misses are model/question-wording variance. This script separates that out: it
// drives the SAME generated question set through the real engine the `kb` tool executes
// (core/src/kb-query.ts — the tool is a thin store-fetch + exec around it; the decode→execute
// tool pipeline itself is covered by core/test/tool-kb.test.ts), feeding each question's GOLD
// query as the tool input. The engine must answer 100% — anything less is a porting bug, not
// model variance.
//
// Usage:  bun script/kb/kb-tool-eval.ts --facts rockfacts.jsonl [--n 0 = all]

import { KbQuery } from "../../packages/core/src/kb-query"

const args = new Map<string, string>()
for (let i = 2; i < Bun.argv.length; i += 2) {
  const k = Bun.argv[i]
  if (k?.startsWith("--")) args.set(k.slice(2), Bun.argv[i + 1] ?? "")
}
const N = Number(args.get("n") ?? 0)

const file = args.get("facts")
if (!file) {
  console.error("pass --facts <rockfacts.jsonl>")
  process.exit(1)
}
const triples: KbQuery.Triple[] = (await Bun.file(file).text())
  .trim()
  .split("\n")
  .map((line) => {
    const fact = JSON.parse(line) as { subject: string; predicate: string; object: string }
    return { s: fact.subject, p: fact.predicate, o: fact.object }
  })
const index = KbQuery.buildIndex(triples)
console.log(`loaded ${triples.length} triples`)

// ── the question set (same generation logic as nova-query-eval.ts) + each question's GOLD op ──
interface Case {
  text: string
  answers: string[]
  hops: 1 | 2
  gold: KbQuery.Op
}
const bySubject = new Map<string, KbQuery.Triple[]>()
for (const t of triples) {
  const list = bySubject.get(t.s) ?? []
  list.push(t)
  bySubject.set(t.s, list)
}
const get = (s: string, p: string) => bySubject.get(s)?.find((t) => t.p === p)?.o
const musicians = triples.filter((t) => t.p === "type" && t.o === "musician").map((t) => t.s)
const bands = triples.filter((t) => t.p === "type" && t.o === "band").map((t) => t.s)

const cases: Case[] = []
for (const m of musicians) {
  const name = get(m, "name")
  const band = get(m, "member_of")
  if (name && band)
    cases.push({
      text: `Which band is the musician "${name}" a member of?`,
      answers: [band],
      hops: 1,
      gold: { op: "neighbors", entity: name, predicate: "member_of" },
    })
}
for (const b of bands) {
  const name = get(b, "name")
  const city = get(b, "origin_city")
  const founded = get(b, "founded_in")
  if (name && city)
    cases.push({
      text: `In which city was the band "${name}" formed?`,
      answers: [city],
      hops: 1,
      gold: { op: "neighbors", entity: name, predicate: "origin_city" },
    })
  if (name && founded)
    cases.push({
      text: `In which year was the band "${name}" founded?`,
      answers: [founded],
      hops: 1,
      gold: { op: "neighbors", entity: name, predicate: "founded_in" },
    })
}
for (const m of musicians) {
  const name = get(m, "name")
  const bandName = get(m, "member_of")
  const bandSlug = bands.find((b) => get(b, "name") === bandName)
  const city = bandSlug ? get(bandSlug, "origin_city") : undefined
  if (name && city)
    cases.push({
      text: `What is the origin_city of the band that "${name}" is a member of?`,
      answers: [city],
      hops: 2,
      gold: {
        op: "match",
        find: ["?city"],
        where: [
          [name, "member_of", "?band"],
          ["?band", "origin_city", "?city"],
        ],
      },
    })
}

const picked = N > 0 && cases.length > N ? cases.filter((_, i) => i % Math.ceil(cases.length / N) === 0).slice(0, N) : cases

const norm = (s: string) => s.trim().toLowerCase()
const correct = (got: ReadonlyArray<string>, answers: string[]) => {
  const set = new Set(got.map(norm))
  return got.length > 0 && answers.every((a) => set.has(norm(a)))
}

let ok = 0
let ok1 = 0
let t1 = 0
let ok2 = 0
let t2 = 0
const failures: string[] = []
for (const c of picked) {
  const result = KbQuery.exec(index, c.gold)
  const hit = result.ok && correct(result.lines, c.answers)
  if (c.hops === 1) t1++
  else t2++
  if (hit) {
    ok++
    if (c.hops === 1) ok1++
    else ok2++
  } else {
    failures.push(`${c.text} → expected ${JSON.stringify(c.answers)}, got ${result.ok ? JSON.stringify(result.lines.slice(0, 3)) : `ERROR: ${result.error}`}`)
  }
}

// ── full-vocabulary sweep: find / get / predicates / count on sampled entities ────────────────
const sweep: string[] = []
for (const m of musicians.slice(0, 25)) {
  const name = get(m, "name")
  const band = get(m, "member_of")
  if (!name || !band) continue
  const found = KbQuery.exec(index, { op: "find", label: name })
  if (!(found.ok && found.lines[0] === name)) sweep.push(`find "${name}" → ${JSON.stringify(found)}`)
  const facts = KbQuery.exec(index, { op: "get", entity: name })
  if (!(facts.ok && facts.lines.some((l) => l === `member_of: ${band}`))) sweep.push(`get "${name}" missing member_of`)
  const preds = KbQuery.exec(index, { op: "predicates", entity: name })
  if (!(preds.ok && preds.lines.includes("member_of"))) sweep.push(`predicates "${name}" missing member_of`)
}
for (const b of bands.slice(0, 10)) {
  const name = get(b, "name")
  if (!name) continue
  const truth = new Set(triples.filter((t) => t.p === "member_of" && t.o === name).map((t) => t.s)).size
  if (truth === 0) continue
  const counted = KbQuery.exec(index, { op: "count", find: ["?m"], where: [["?m", "member_of", name]] })
  if (!(counted.ok && counted.lines[0] === String(truth))) sweep.push(`count members of "${name}" → ${JSON.stringify(counted)} (truth ${truth})`)
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`)
console.log(`gold-query accuracy: ${pct(ok, picked.length)} (${ok}/${picked.length}) · 1-hop ${pct(ok1, t1)} (${ok1}/${t1}) · 2-hop ${pct(ok2, t2)} (${ok2}/${t2})`)
console.log(`vocabulary sweep (find/get/predicates/count): ${sweep.length === 0 ? "clean" : sweep.length + " failures"}`)
for (const f of [...failures, ...sweep].slice(0, 10)) console.log("  ✗ " + f)

if (ok !== picked.length || sweep.length > 0) {
  console.error("\nFAIL — the engine must answer every gold query (a miss is a porting bug)")
  process.exit(1)
}
console.log("\nPASS — the native engine answers the full eval question set on gold queries")
