import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@novaclaw/core/database/database"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { KbChunker } from "@novaclaw/core/kb-vec/chunker"
import { KbDocs } from "@novaclaw/core/kb-docs"
import { KbEmbedder } from "@novaclaw/core/kb-vec/embedder"

const DIMS = 4

// A deterministic "semantic" stub: axis 0 = programming, axis 1 = cooking, axis 2 = other.
const stubVector = (text: string): number[] => {
  const lower = text.toLowerCase()
  if (/rust|ownership|borrow/.test(lower)) return [1, 0, 0, 0]
  if (/pasta|spaghetti|boil/.test(lower)) return [0, 1, 0, 0]
  return [0, 0, 1, 0]
}
const stub = KbEmbedder.layerStub(stubVector, { model: "stub-4d", dims: DIMS })
const failingStub = Layer.succeed(
  KbEmbedder.Service,
  KbEmbedder.Service.of({
    info: { model: "stub-4d", dims: DIMS },
    embed: () => Effect.fail(new KbEmbedder.EmbedError({ reason: "device down" })),
  }),
)

// One physical :memory: DB per test; KbDocs layers (with different embedders) build over the
// SAME Database so failure→recovery sequences see one store.
const run = <A, E>(
  build: (dbLayer: Layer.Layer<Database.Service>) => Effect.Effect<A, E, SqlClientService>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      return yield* build(Layer.succeed(Database.Service, { db }))
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const RUST = {
  title: "Rust memory model",
  text: "Rust ownership rules. Borrowing enforces lifetimes.",
  relation: "core" as const,
  source: "test",
}
const PASTA = {
  title: "Cooking pasta",
  text: "Boil salted water. Add spaghetti and stir.",
  relation: "staged" as const,
  agent: "chef",
}

describe("KbChunker", () => {
  test("short text is one chunk; empty text is none", () => {
    expect(KbChunker.chunk("")).toEqual([])
    expect(KbChunker.chunk("  \n\n  ")).toEqual([])
    const one = KbChunker.chunk("A tiny note.")
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ seq: 0, text: "A tiny note." })
  })

  test("long text splits near the target with sentence overlap", () => {
    const sentence = "This sentence talks about a topic in some detail and keeps going for a while."
    const text = Array.from({ length: 40 }, (_, at) => `${sentence} Item ${at}.`).join("\n\n")
    const chunks = KbChunker.chunk(text, { target: 100 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const item of chunks) expect(item.tokenEstimate).toBeLessThan(180)
    // Overlap: each later chunk starts with the previous chunk's last unit.
    const first = chunks[0]!.text
    expect(chunks[1]!.text.startsWith(first.slice(first.lastIndexOf("Item")))).toBe(true)
    // seq is dense.
    expect(chunks.map((item) => item.seq)).toEqual(chunks.map((_, at) => at))
  })

  test("a giant unbroken line hard-splits instead of producing one oversized chunk", () => {
    const chunks = KbChunker.chunk("x".repeat(4000), { target: 100 })
    expect(chunks.length).toBeGreaterThan(5)
    for (const item of chunks) expect(item.tokenEstimate).toBeLessThanOrEqual(101)
  })
})

describe("KbDocs", () => {
  test("add dedups by content hash and indexes keywords immediately (vectors pending)", async () => {
    await run((dbLayer) =>
      Effect.gen(function* () {
        const kb = yield* KbDocs.Service
        const first = yield* kb.add(RUST)
        expect(first.deduped).toBe(false)
        const again = yield* kb.add(RUST)
        expect(again).toMatchObject({ deduped: true, doc: { id: first.doc.id } })

        // Keyword search works BEFORE any embedding drain (the forgiving-ingestion stance).
        const found = yield* kb.search({ query: "borrowing lifetimes" })
        expect(found.hits.map((hit) => hit.docID)).toEqual([first.doc.id])
        expect(found.hits[0]).toMatchObject({ title: RUST.title, relation: "core", source: "test" })

        const stats = yield* kb.stats()
        expect(stats).toMatchObject({ docs: 1, vector: true, embedModel: "stub-4d" })
        expect(stats.pendingChunks).toBeGreaterThan(0)
      }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer), Layer.provide(stub)))),
    )
  })

  test("drain embeds pending chunks; hybrid search then hits on meaning, scope filters apply", async () => {
    await run((dbLayer) =>
      Effect.gen(function* () {
        const kb = yield* KbDocs.Service
        const rust = (yield* kb.add(RUST)).doc
        const pasta = (yield* kb.add(PASTA)).doc

        const drained = yield* kb.drainEmbeddings()
        expect(drained.failed).toBe(0)
        expect(drained.embedded).toBeGreaterThan(0)
        expect(drained.remaining).toBe(0)
        expect((yield* kb.stats()).pendingChunks).toBe(0)
        expect((yield* kb.get(rust.id))?.embedModel).toBe("stub-4d")

        // "memory safety" shares no keyword with the rust doc — only the vector leg finds it.
        const semantic = yield* kb.search({ query: "memory safety borrow checker" })
        expect(semantic.vector).toBe(true)
        expect(semantic.hits[0]?.docID).toBe(rust.id)

        const scoped = yield* kb.search({ query: "boil spaghetti", scope: "staged" })
        expect(scoped.hits.map((hit) => hit.docID)).toEqual([pasta.id])
        // Scope is a hard wall: core-only can NEVER surface the staged doc. (It may still
        // surface a weakly-related core chunk — KNN is uncapped by design; thresholds are a
        // P5-eval decision, not a hardcode.)
        const wrongScope = yield* kb.search({ query: "boil spaghetti", scope: "core" })
        expect(wrongScope.hits.map((hit) => hit.docID)).not.toContain(pasta.id)
      }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer), Layer.provide(stub)))),
    )
  })

  test("a dead embedder marks chunks failed; the next drain (device back) recovers them", async () => {
    await run((dbLayer) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const kb = yield* KbDocs.Service
          yield* kb.add(RUST)
          const drained = yield* kb.drainEmbeddings()
          expect(drained.embedded).toBe(0)
          expect(drained.failed).toBeGreaterThan(0)
          // Search still answers (FTS leg; the vector leg quietly skips on embed failure).
          const found = yield* kb.search({ query: "ownership" })
          expect(found.hits).toHaveLength(1)
          expect(found.vector).toBe(false)
        }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer), Layer.provide(failingStub))))

        yield* Effect.gen(function* () {
          const kb = yield* KbDocs.Service
          const drained = yield* kb.drainEmbeddings()
          expect(drained.failed).toBe(0)
          expect(drained.embedded).toBeGreaterThan(0)
          expect(drained.remaining).toBe(0)
        }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer), Layer.provide(stub))))
      }),
    )
  })

  test("retract stamps the doc and removes its chunks from every index", async () => {
    await run((dbLayer) =>
      Effect.gen(function* () {
        const kb = yield* KbDocs.Service
        const doc = (yield* kb.add(PASTA)).doc
        yield* kb.drainEmbeddings()
        const retracted = yield* kb.retract(doc.id)
        expect(retracted.validTo).toBeDefined()
        expect((yield* kb.search({ query: "spaghetti" })).hits).toEqual([])
        expect((yield* kb.stats()).chunks).toBe(0)
        // Dated move, not a delete: the row is still readable.
        expect((yield* kb.get(doc.id))?.validTo).toBeDefined()
        const missing = yield* kb.retract(doc.id).pipe(Effect.flip)
        expect(missing).toMatchObject({ _tag: "KbDocs.NotFoundError" })
      }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer), Layer.provide(stub)))),
    )
  })

  test("update is a dated move: old text stops matching, the chain is auditable", async () => {
    await run((dbLayer) =>
      Effect.gen(function* () {
        const kb = yield* KbDocs.Service
        const doc = (yield* kb.add(PASTA)).doc
        yield* kb.drainEmbeddings()
        const next = yield* kb.update(doc.id, { text: "Bake the lasagna in the oven." })
        expect(next.id).not.toBe(doc.id)
        const old = yield* kb.get(doc.id)
        expect(old).toMatchObject({ supersededBy: next.id })
        expect(old?.validTo).toBeDefined()
        expect((yield* kb.search({ query: "spaghetti" })).hits).toEqual([])
        expect((yield* kb.search({ query: "lasagna" })).hits.map((hit) => hit.docID)).toEqual([next.id])
      }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer), Layer.provide(stub)))),
    )
  })

  test("without an embedder the KB is keyword-only but fully functional", async () => {
    await run((dbLayer) =>
      Effect.gen(function* () {
        const kb = yield* KbDocs.Service
        const doc = (yield* kb.add(RUST)).doc
        const drained = yield* kb.drainEmbeddings()
        expect(drained.embedded).toBe(0)
        expect(drained.remaining).toBeGreaterThan(0)
        const found = yield* kb.search({ query: "ownership" })
        expect(found).toMatchObject({ vector: false })
        expect(found.hits.map((hit) => hit.docID)).toEqual([doc.id])
        expect((yield* kb.stats()).vector).toBe(false)
      }).pipe(Effect.provide(KbDocs.layer.pipe(Layer.provide(dbLayer)))),
    )
  })
})
