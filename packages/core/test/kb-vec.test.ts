import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { KbVecStore } from "@novaclaw/core/kb-vec/store"
import { KbVecQuery } from "@novaclaw/core/kb-vec-query"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

type Db = Effect.Success<typeof makeDb>
const unsafe = (db: Db) => {
  const client = (db as unknown as { $client: { unsafe: (s: string, p?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown> } }).$client
  return <T = Record<string, unknown>>(statement: string, params?: ReadonlyArray<unknown>) =>
    client.unsafe(statement, params) as Effect.Effect<ReadonlyArray<T>, unknown>
}

const DIMS = 4

const seed = (db: Db) =>
  Effect.gen(function* () {
    // Two active docs (one core, one staged) + one superseded doc that must never surface.
    yield* db.run(sql`
      INSERT INTO kb_doc (id, title, text, relation, source, content_hash, valid_from, time_created) VALUES
      ('doc_rust', 'Rust memory model', 'rust ownership borrowing lifetimes', 'core', 'test', 'h1', 1, 1),
      ('doc_pasta', 'Cooking pasta', 'boil salted water for spaghetti', 'staged', 'test', 'h2', 1, 1),
      ('doc_old', 'Old rust doc', 'rust rust rust outdated', 'core', 'test', 'h3', 1, 1)
    `)
    yield* db.run(sql`UPDATE kb_doc SET valid_to = 2, superseded_by = 'doc_rust' WHERE id = 'doc_old'`)
    yield* db.run(sql`
      INSERT INTO kb_chunk (id, doc_id, seq, text, token_estimate, embed_status) VALUES
      ('chk_rust', 'doc_rust', 0, 'rust ownership borrowing lifetimes', 5, 'done'),
      ('chk_pasta', 'doc_pasta', 0, 'boil salted water for spaghetti', 5, 'done'),
      ('chk_old', 'doc_old', 0, 'rust rust rust outdated', 4, 'done')
    `)
  })

describe("KbVecStore", () => {
  test("resolves a vendored binary for this platform", () => {
    expect(KbVecStore.binaryPath()).toBeDefined()
  })

  test("vecBlob encodes little-endian float32", () => {
    const blob = KbVecStore.vecBlob([1, -2, 0.5])
    expect(blob.byteLength).toBe(12)
    expect(new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + 12))[1]).toBe(-2)
  })

  test("ensure loads the extension, creates the vec table, and KNN + scope filtering work", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const capability = yield* KbVecStore.ensure(db, { dims: DIMS })
        expect(capability).toEqual({ vector: true })
        // Idempotent re-ensure.
        expect(yield* KbVecStore.ensure(db, { dims: DIMS })).toEqual({ vector: true })
        yield* seed(db)

        const exec = unsafe(db)
        const insert = `INSERT INTO kb_chunk_vec (chunk_id, embedding, relation, doc_id, snippet) VALUES (?, ?, ?, ?, ?)`
        yield* exec(insert, ["chk_rust", KbVecStore.vecBlob([1, 0, 0, 0]), "core", "doc_rust", "rust ownership"])
        yield* exec(insert, ["chk_pasta", KbVecStore.vecBlob([0, 1, 0, 0]), "staged", "doc_pasta", "boil salted"])

        const near = yield* exec<KbVecQuery.Hit>(KbVecQuery.knnSql("all"), [
          KbVecStore.vecBlob([0.9, 0.1, 0, 0]),
          2,
        ])
        expect(near.map((row) => row.chunkID)).toEqual(["chk_rust", "chk_pasta"])
        expect(near[0]).toMatchObject({ docID: "doc_rust", snippet: "rust ownership" })

        // The relation partition key scopes the KNN: staged-only never sees the core chunk.
        const staged = yield* exec<KbVecQuery.Hit>(KbVecQuery.knnSql("staged"), [
          KbVecStore.vecBlob([0.9, 0.1, 0, 0]),
          2,
          "staged",
        ])
        expect(staged.map((row) => row.chunkID)).toEqual(["chk_pasta"])
      }),
    )
  })

  test("FTS triggers keep the keyword index synced and the query joins out superseded docs", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* KbVecStore.ensure(db, { dims: DIMS })
        yield* seed(db)

        const exec = unsafe(db)
        const match = KbVecQuery.ftsMatchExpr("rust ownership")
        expect(match).toBe(`"rust" OR "ownership"`)
        const hits = yield* exec<KbVecQuery.Hit>(KbVecQuery.ftsSql("all"), [match!, 10])
        // chk_old matches "rust" in the FTS index but its doc is superseded — joined out.
        expect(hits.map((row) => row.chunkID)).toEqual(["chk_rust"])

        // Scope filter: core-only hides the staged pasta doc even when it matches.
        const staged = yield* exec<KbVecQuery.Hit>(KbVecQuery.ftsSql("core"), [
          KbVecQuery.ftsMatchExpr("spaghetti rust")!,
          10,
          "core",
        ])
        expect(staged.map((row) => row.chunkID)).toEqual(["chk_rust"])

        // Trigger sync: an UPDATE re-indexes, a DELETE drops the row from the index.
        yield* db.run(sql`UPDATE kb_chunk SET text = 'completely different topic' WHERE id = 'chk_rust'`)
        expect(yield* exec(KbVecQuery.ftsSql("all"), [KbVecQuery.ftsMatchExpr("ownership")!, 10])).toEqual([])
        yield* db.run(sql`DELETE FROM kb_chunk WHERE id = 'chk_pasta'`)
        expect(yield* exec(KbVecQuery.ftsSql("all"), [KbVecQuery.ftsMatchExpr("spaghetti")!, 10])).toEqual([])
      }),
    )
  })

  test("degrades to FTS-only when the extension client is unavailable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        // A caller without the native loadExtension seam (e.g. an exotic driver): keyword
        // search must still fully work — vec is a capability, never a requirement.
        const capability = yield* KbVecStore.ensure({ run: (statement: string) => db.run(statement) })
        expect(capability).toEqual({ vector: false })
        yield* seed(db)
        const exec = unsafe(db)
        const hits = yield* exec<KbVecQuery.Hit>(KbVecQuery.ftsSql("all"), [
          KbVecQuery.ftsMatchExpr("spaghetti")!,
          10,
        ])
        expect(hits.map((row) => row.chunkID)).toEqual(["chk_pasta"])
      }),
    )
  })
})

describe("KbVecQuery", () => {
  test("ftsMatchExpr quotes operators and refuses empty input", () => {
    expect(KbVecQuery.ftsMatchExpr(`NEAR("a" b) AND -c`)).toBe(`"NEAR" OR "a" OR "b" OR "AND" OR "c"`)
    expect(KbVecQuery.ftsMatchExpr("  \t ")).toBeUndefined()
  })

  test("rrfFuse rewards items ranked by both generators and slices to k", () => {
    const hit = (chunkID: string): KbVecQuery.Hit => ({ chunkID, docID: `d_${chunkID}`, snippet: chunkID })
    const vector = [hit("both"), hit("vec_only"), hit("tail")]
    const keyword = [hit("kw_only"), hit("both")]
    const fused = KbVecQuery.rrfFuse([vector, keyword], 2)
    // "both": 1/61 + 1/62 beats "kw_only": 1/61 and "vec_only": 1/62.
    expect(fused.map((row) => row.chunkID)).toEqual(["both", "kw_only"])
    expect(fused).toHaveLength(2)
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score)
  })

  test("candidateLimit floors at 20", () => {
    expect(KbVecQuery.candidateLimit(3)).toBe(20)
    expect(KbVecQuery.candidateLimit(10)).toBe(40)
  })
})
