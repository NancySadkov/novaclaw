#!/usr/bin/env bun
// kb-vec-seed.ts — KB-V: seed entity DOCUMENTS from a triples jsonl into THE instance database
// (Database.path() under the current env — run it with the same XDG/env as the target serve).
// This is the P4 kb_fact→docs migration vehicle and the P5 smoke's seeder: triples linearize
// per-subject via KbLinearize (one doc per entity), ingest through the real KbDocs write path
// (hash dedup, chunking, FTS triggers), then optionally drain embeddings against a live device.
//
// Usage:
//   bun packages/core/script/kb-vec-seed.ts --facts rockfacts.jsonl \
//     [--embed-url http://spark:8001/v1 --embed-model qwen3-embedding] \
//     [--relation core] [--source rockfacts]

import fs from "node:fs"
import path from "node:path"
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
const file = args.get("facts")
if (!file) {
  console.error("pass --facts <triples.jsonl>")
  process.exit(1)
}
const relation = (args.get("relation") ?? "core") as "core" | "staged"
const source = args.get("source") ?? "seed"
const embedUrl = args.get("embed-url")
const embedder = embedUrl
  ? KbEmbedder.make({ url: embedUrl, model: args.get("embed-model") ?? "qwen3-embedding", timeoutMs: 90_000 })
  : undefined

const triples = (await Bun.file(file).text())
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { subject: string; predicate: string; object: string })
const docs = KbLinearize.entityDocs(triples)

const dbFile = Database.path()
fs.mkdirSync(path.dirname(dbFile), { recursive: true })
console.log(`seeding ${docs.length} entity docs (${triples.length} triples) → ${dbFile}`)

const program = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* DatabaseMigration.apply(db)
  const dbLayer = Layer.succeed(Database.Service, { db })
  yield* Effect.gen(function* () {
    const kb = yield* KbDocs.Service
    let added = 0
    let deduped = 0
    for (const doc of docs) {
      const result = yield* kb.add({ title: doc.title, text: doc.text, relation, source })
      if (result.deduped) deduped++
      else added++
    }
    let embedded = 0
    if (embedder) {
      for (;;) {
        const drained = yield* kb.drainEmbeddings({ batch: 64, embedder })
        embedded += drained.embedded
        if (drained.failed > 0) throw new Error(`embed drain failed on ${drained.failed} chunks`)
        if (drained.remaining === 0) break
      }
    }
    const stats = yield* kb.stats(embedder ? { embedder } : undefined)
    console.log(JSON.stringify({ added, deduped, embedded, ...stats }))
  }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer))))
}).pipe(Effect.provide(SqliteClient.layer({ filename: dbFile })), Effect.scoped)

await Effect.runPromise(program)
