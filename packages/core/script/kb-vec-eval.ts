#!/usr/bin/env bun
// kb-vec-eval.ts — KB-V P5, the RETRIEVAL regression gate (no LLM).
//
// Supersedes kb-tool-eval.ts's exact-query gate (the six-op triple engine is dead-ended by the
// KB-V pivot): the same generated rockfacts question set now measures RETRIEVAL — for each
// question, does a top-k `search` surface a document containing the answer? Bar (plan §P5):
// ≥90% recall@5 on 1-hop; 2-hop reported honestly (direct one-shot search is EXPECTED to be
// weak there — the live smoke measures the agentic search→get chain that actually answers
// 2-hop questions).
//
// Usage:
//   bun packages/core/script/kb-vec-eval.ts --facts rockfacts.jsonl                  # FTS-only
//   bun packages/core/script/kb-vec-eval.ts --facts rockfacts.jsonl \
//     --embed-url http://192.168.178.40:8001/v1 --embed-model qwen3-embedding   # hybrid too

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { KbDocs } from "../src/kb-docs"
import { KbEmbedder } from "../src/kb-vec/embedder"
import { KbLinearize } from "../src/kb-vec/linearize"

const args = new Map<string, string>()
for (let i = 2; i < Bun.argv.length; i += 2) {
  const k = Bun.argv[i]
  if (k?.startsWith("--")) args.set(k.slice(2), Bun.argv[i + 1] ?? "")
}
const N = Number(args.get("n") ?? 0)
const K = Number(args.get("k") ?? 5)

const file = args.get("facts")
if (!file) {
  console.error("pass --facts <rockfacts.jsonl>")
  process.exit(1)
}
const embedUrl = args.get("embed-url")
const embedder = embedUrl
  ? KbEmbedder.make({ url: embedUrl, model: args.get("embed-model") ?? "qwen3-embedding", timeoutMs: 90_000 })
  : undefined

interface FactLine {
  subject: string
  predicate: string
  object: string
}
const triples: FactLine[] = (await Bun.file(file).text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as FactLine)
const docs = KbLinearize.entityDocs(triples)
console.log(`loaded ${triples.length} triples → ${docs.length} entity docs`)

// ── the question set (same generation as kb-tool-eval.ts — the corpus is the constant) ────────
interface Case {
  text: string
  answers: string[]
  hops: 1 | 2
}
const bySubject = new Map<string, FactLine[]>()
for (const t of triples) {
  const list = bySubject.get(t.subject) ?? []
  list.push(t)
  bySubject.set(t.subject, list)
}
const get = (s: string, p: string) => bySubject.get(s)?.find((t) => t.predicate === p)?.object
const musicians = triples.filter((t) => t.predicate === "type" && t.object === "musician").map((t) => t.subject)
const bands = triples.filter((t) => t.predicate === "type" && t.object === "band").map((t) => t.subject)

const cases: Case[] = []
for (const m of musicians) {
  const name = get(m, "name")
  const band = get(m, "member_of")
  if (name && band) cases.push({ text: `Which band is the musician "${name}" a member of?`, answers: [band], hops: 1 })
}
for (const b of bands) {
  const name = get(b, "name")
  const city = get(b, "origin_city")
  const founded = get(b, "founded_in")
  if (name && city) cases.push({ text: `In which city was the band "${name}" formed?`, answers: [city], hops: 1 })
  if (name && founded)
    cases.push({ text: `In which year was the band "${name}" founded?`, answers: [founded], hops: 1 })
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
    })
}
const picked =
  N > 0 && cases.length > N ? cases.filter((_, i) => i % Math.ceil(cases.length / N) === 0).slice(0, N) : cases
console.log(`${picked.length} questions (${picked.filter((c) => c.hops === 1).length} 1-hop / ${picked.filter((c) => c.hops === 2).length} 2-hop)`)

const norm = (s: string) => s.trim().toLowerCase()

const program = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* DatabaseMigration.apply(db)
  const dbLayer = Layer.succeed(Database.Service, { db })

  yield* Effect.gen(function* () {
    const kb = yield* KbDocs.Service
    const t0 = Date.now()
    for (const doc of docs)
      yield* kb.add({ title: doc.title, text: doc.text, relation: "core", source: "rockfacts" })
    console.log(`ingested ${docs.length} docs in ${Date.now() - t0} ms`)

    if (embedder) {
      const t1 = Date.now()
      let total = 0
      for (;;) {
        const drained = yield* kb.drainEmbeddings({ batch: 64, embedder })
        total += drained.embedded
        if (drained.failed > 0) throw new Error(`embed drain failed on ${drained.failed} chunks`)
        if (drained.remaining === 0) break
      }
      console.log(`embedded ${total} chunks in ${Date.now() - t1} ms`)
    }

    // Answer-containment recall@K: a question scores when any top-K doc's text carries every
    // answer string. Text containment (not doc-id gold) keeps the criterion honest for 2-hop,
    // where the answer lives on a DIFFERENT entity than the one the question names.
    const docText = new Map<string, string>()
    const evaluate = Effect.fnUntraced(function* (useEmbedder: boolean) {
      let ok1 = 0,
        t1 = 0,
        ok2 = 0,
        t2 = 0
      const misses: string[] = []
      for (const c of picked) {
        const result = yield* kb.search({
          query: c.text,
          k: K,
          ...(useEmbedder && embedder ? { embedder } : {}),
        })
        let hit = false
        for (const found of result.hits) {
          let text = docText.get(found.docID)
          if (text === undefined) {
            text = (yield* kb.get(found.docID))?.text ?? ""
            docText.set(found.docID, text)
          }
          const haystack = norm(text)
          if (c.answers.every((answer) => haystack.includes(norm(answer)))) {
            hit = true
            break
          }
        }
        if (c.hops === 1) {
          t1++
          if (hit) ok1++
        } else {
          t2++
          if (hit) ok2++
        }
        if (!hit && misses.length < 5) misses.push(`${c.text} → ${JSON.stringify(c.answers)}`)
      }
      return { ok1, t1, ok2, t2, misses }
    })

    const report = (label: string, r: { ok1: number; t1: number; ok2: number; t2: number; misses: string[] }) => {
      const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`)
      console.log(
        `${label}: 1-hop recall@${K} ${r.ok1}/${r.t1} = ${pct(r.ok1, r.t1)} · 2-hop ${r.ok2}/${r.t2} = ${pct(r.ok2, r.t2)} · overall ${pct(r.ok1 + r.ok2, r.t1 + r.t2)}`,
      )
      for (const miss of r.misses) console.log(`  miss: ${miss}`)
    }

    const tf = Date.now()
    report("FTS-only ", yield* evaluate(false))
    console.log(`  (${Date.now() - tf} ms)`)
    if (embedder) {
      const th = Date.now()
      report("hybrid   ", yield* evaluate(true))
      console.log(`  (${Date.now() - th} ms)`)
    }
  }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer))))
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped)

await Effect.runPromise(program)
