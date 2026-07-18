export * as KbDocs from "./kb-docs"

// KB-V P2 — the document knowledge store (notes/kb-vector-plan.md §3–§5): forgiving ingestion
// of ANY text with the write discipline carried over verbatim from the fact store — provenance
// on every row, dated moves (update/retract stamp valid_to + superseded_by, never rewrite), and
// agent writes staying relation="staged" forever. Chunks index into FTS immediately (triggers);
// vectors arrive asynchronously via drainEmbeddings, so a down embedding device degrades search
// to keyword-only instead of failing anything (the KB-V stance: embedder down ≠ KB down).
//
// This module deliberately does NOT reshape the legacy `Kb` fact facade in place: the six-op
// triple tool stays routed until KB-V P4 deletes it, and a green tree between slices beats the
// plan's letter (deviation recorded in the plan ledger).

import { createHash } from "node:crypto"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ascending } from "@novaclaw/schema/identifier"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { KbChunker } from "./kb-vec/chunker"
import { KbEmbedder } from "./kb-vec/embedder"
import { KbVecQuery } from "./kb-vec-query"
import { KbVecStore } from "./kb-vec/store"
import { KbChunkTable, KbDocTable } from "./kb-vec/sql"

export const createID = (): string => "doc_" + ascending()
const chunkID = (): string => "chk_" + ascending()

export const contentHash = (title: string, text: string): string =>
  createHash("sha256").update(`${title}\n${text}`).digest("hex")

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("KbDocs.NotFoundError", {
  id: Schema.String,
}) {}

export interface Doc {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly relation: "core" | "staged"
  readonly source?: string
  readonly agent?: string
  readonly confidence?: number
  readonly contentHash: string
  readonly embedModel?: string
  readonly validFrom: number
  readonly validTo?: number
  readonly supersededBy?: string
  readonly timeCreated: number
}

export interface AddInput {
  readonly title: string
  readonly text: string
  readonly relation?: "core" | "staged"
  readonly source?: string
  readonly agent?: string
  readonly confidence?: number
}

export interface SearchInput {
  readonly query: string
  readonly k?: number
  readonly scope?: KbVecQuery.Scope
}

export interface SearchHit {
  readonly docID: string
  readonly chunkID: string
  readonly title: string
  readonly snippet: string
  readonly score: number
  readonly relation: "core" | "staged"
  readonly source?: string
  readonly agent?: string
}

export interface SearchResult {
  readonly hits: SearchHit[]
  /** False when the vector leg was unavailable for this query (no extension/embedder/failure). */
  readonly vector: boolean
}

export interface DrainResult {
  readonly embedded: number
  readonly failed: number
  readonly remaining: number
}

export interface Stats {
  readonly docs: number
  readonly chunks: number
  readonly pendingChunks: number
  readonly vector: boolean
  readonly embedModel?: string
}

export interface Interface {
  readonly add: (input: AddInput) => Effect.Effect<{ doc: Doc; deduped: boolean }>
  readonly get: (id: string) => Effect.Effect<Doc | undefined>
  readonly update: (id: string, patch: Partial<AddInput>) => Effect.Effect<Doc, NotFoundError>
  readonly retract: (id: string) => Effect.Effect<Doc, NotFoundError>
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult>
  readonly drainEmbeddings: (options?: { batch?: number }) => Effect.Effect<DrainResult>
  readonly stats: () => Effect.Effect<Stats>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/KbDocs") {}

type Row = typeof KbDocTable.$inferSelect

const toDoc = (row: Row): Doc =>
  ({
    id: row.id,
    title: row.title,
    text: row.text,
    relation: row.relation,
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.agent !== null ? { agent: row.agent } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    contentHash: row.content_hash,
    ...(row.embed_model !== null ? { embedModel: row.embed_model } : {}),
    validFrom: row.valid_from,
    ...(row.valid_to !== null ? { validTo: row.valid_to } : {}),
    ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
    timeCreated: row.time_created,
  }) as Doc

interface Unsafe {
  unsafe: (sql: string, params?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const embedder = Option.getOrUndefined(yield* Effect.serviceOption(KbEmbedder.Service))
    const capability = yield* KbVecStore.ensure(db, embedder ? { dims: embedder.info.dims } : undefined)
    const raw = (db as unknown as { $client: Unsafe }).$client
    const exec = <T = Record<string, unknown>>(statement: string, params?: ReadonlyArray<unknown>) =>
      raw.unsafe(statement, params).pipe(Effect.orDie) as Effect.Effect<ReadonlyArray<T>>

    const insertDoc = (input: AddInput, now: number, embedModel?: string) => {
      const id = createID()
      return db
        .insert(KbDocTable)
        .values({
          id,
          title: input.title,
          text: input.text,
          relation: input.relation ?? "staged",
          source: input.source ?? null,
          agent: input.agent ?? null,
          confidence: input.confidence ?? null,
          content_hash: contentHash(input.title, input.text),
          embed_model: embedModel ?? null,
          valid_from: now,
          valid_to: null,
          superseded_by: null,
          time_created: now,
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
    }

    const insertChunks = (docID: string, text: string) =>
      Effect.gen(function* () {
        const chunks = KbChunker.chunk(text)
        if (chunks.length === 0) return 0
        yield* db
          .insert(KbChunkTable)
          .values(
            chunks.map((chunk) => ({
              id: chunkID(),
              doc_id: docID,
              seq: chunk.seq,
              text: chunk.text,
              token_estimate: chunk.tokenEstimate,
              embed_status: "pending" as const,
            })),
          )
          .pipe(Effect.orDie)
        return chunks.length
      })

    // Chunk removal: the FTS index follows via triggers; vec rows need the explicit delete
    // (vec0 virtual tables have no triggers on the content table).
    const removeChunks = (docID: string) =>
      Effect.gen(function* () {
        if (capability.vector) yield* exec(`DELETE FROM kb_chunk_vec WHERE doc_id = ?`, [docID])
        yield* db.delete(KbChunkTable).where(eq(KbChunkTable.doc_id, docID)).pipe(Effect.orDie)
      })

    const requireActive = Effect.fnUntraced(function* (id: string) {
      const row = yield* db.select().from(KbDocTable).where(eq(KbDocTable.id, id)).get().pipe(Effect.orDie)
      if (!row || row.valid_to !== null) return yield* new NotFoundError({ id })
      return row
    })

    const add: Interface["add"] = Effect.fn("KbDocs.add")(function* (input) {
      const hash = contentHash(input.title, input.text)
      const existing = yield* db
        .select()
        .from(KbDocTable)
        .where(and(eq(KbDocTable.content_hash, hash), isNull(KbDocTable.valid_to)))
        .get()
        .pipe(Effect.orDie)
      if (existing) return { doc: toDoc(existing), deduped: true }
      const row = yield* insertDoc(input, Date.now())
      yield* insertChunks(row.id, row.text)
      return { doc: toDoc(row), deduped: false }
    })

    const get: Interface["get"] = Effect.fn("KbDocs.get")(function* (id) {
      const row = yield* db.select().from(KbDocTable).where(eq(KbDocTable.id, id)).get().pipe(Effect.orDie)
      return row ? toDoc(row) : undefined
    })

    const retract: Interface["retract"] = Effect.fn("KbDocs.retract")(function* (id) {
      const row = yield* requireActive(id)
      const now = Date.now()
      const stamped = yield* db
        .update(KbDocTable)
        .set({ valid_to: now })
        .where(eq(KbDocTable.id, id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      yield* removeChunks(id)
      return toDoc(stamped!)
    })

    const update: Interface["update"] = Effect.fn("KbDocs.update")(function* (id, patch) {
      const row = yield* requireActive(id)
      const now = Date.now()
      const next = yield* insertDoc(
        {
          title: patch.title ?? row.title,
          text: patch.text ?? row.text,
          relation: patch.relation ?? row.relation,
          source: patch.source ?? row.source ?? undefined,
          agent: patch.agent ?? row.agent ?? undefined,
          confidence: patch.confidence ?? row.confidence ?? undefined,
        },
        now,
      )
      // Audit chain: the old row is stamped, never rewritten.
      yield* db
        .update(KbDocTable)
        .set({ valid_to: now, superseded_by: next.id })
        .where(eq(KbDocTable.id, id))
        .pipe(Effect.orDie)
      yield* removeChunks(id)
      yield* insertChunks(next.id, next.text)
      return toDoc(next)
    })

    const search: Interface["search"] = Effect.fn("KbDocs.search")(function* (input) {
      const k = Math.min(Math.max(1, Math.floor(input.k ?? 8)), 50)
      const scope = input.scope ?? "all"
      const limit = KbVecQuery.candidateLimit(k)
      const scopeParams = scope === "all" ? [] : [scope]

      const lists: KbVecQuery.Hit[][] = []
      let vectorLeg = false
      if (capability.vector && embedder !== undefined) {
        const embedded = yield* embedder.embed([input.query]).pipe(
          Effect.map((vectors) => vectors[0]),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (embedded !== undefined) {
          lists.push([
            ...(yield* exec<KbVecQuery.Hit>(KbVecQuery.knnSql(scope), [
              KbVecStore.vecBlob(embedded),
              limit,
              ...scopeParams,
            ])),
          ])
          vectorLeg = true
        }
      }
      const match = KbVecQuery.ftsMatchExpr(input.query)
      if (match !== undefined)
        lists.push([...(yield* exec<KbVecQuery.Hit>(KbVecQuery.ftsSql(scope), [match, limit, ...scopeParams]))])

      const fused = KbVecQuery.rrfFuse(lists, k)
      if (fused.length === 0) return { hits: [], vector: vectorLeg }
      const docs = yield* db
        .select()
        .from(KbDocTable)
        .where(inArray(KbDocTable.id, [...new Set(fused.map((hit) => hit.docID))]))
        .all()
        .pipe(Effect.orDie)
      const byID = new Map(docs.map((row) => [row.id, row]))
      const hits = fused.flatMap((hit) => {
        const doc = byID.get(hit.docID)
        // Defensive: a vec row whose doc vanished mid-query (or was superseded) never surfaces.
        if (!doc || doc.valid_to !== null) return []
        return [
          {
            docID: hit.docID,
            chunkID: hit.chunkID,
            title: doc.title,
            snippet: hit.snippet,
            score: hit.score,
            relation: doc.relation,
            ...(doc.source !== null ? { source: doc.source } : {}),
            ...(doc.agent !== null ? { agent: doc.agent } : {}),
          } satisfies SearchHit,
        ]
      })
      return { hits, vector: vectorLeg }
    })

    const drainEmbeddings: Interface["drainEmbeddings"] = Effect.fn("KbDocs.drainEmbeddings")(function* (options) {
      const batch = Math.min(Math.max(1, Math.floor(options?.batch ?? 32)), 128)
      const pendingOf = () =>
        db
          .select({ count: KbChunkTable.id })
          .from(KbChunkTable)
          .where(inArray(KbChunkTable.embed_status, ["pending", "failed"]))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.length),
          )
      if (!capability.vector || embedder === undefined) return { embedded: 0, failed: 0, remaining: yield* pendingOf() }

      // Failed chunks re-enter each drain pass — "retry on next pass" is the whole retry policy.
      const rows = yield* db
        .select({
          id: KbChunkTable.id,
          doc_id: KbChunkTable.doc_id,
          text: KbChunkTable.text,
          title: KbDocTable.title,
          relation: KbDocTable.relation,
        })
        .from(KbChunkTable)
        .innerJoin(KbDocTable, eq(KbDocTable.id, KbChunkTable.doc_id))
        .where(and(inArray(KbChunkTable.embed_status, ["pending", "failed"]), isNull(KbDocTable.valid_to)))
        .orderBy(asc(KbChunkTable.id))
        .limit(batch)
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return { embedded: 0, failed: 0, remaining: 0 }

      // Title-prefixed embed text (plan §3): a chunk carries its document's identity into the
      // vector so "what is X" queries land even when the chunk body never names X.
      const vectors = yield* embedder.embed(rows.map((row) => `${row.title} — ${row.text}`)).pipe(
        Effect.map((result) => [...result]),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (vectors === undefined) {
        yield* db
          .update(KbChunkTable)
          .set({ embed_status: "failed" })
          .where(
            inArray(
              KbChunkTable.id,
              rows.map((row) => row.id),
            ),
          )
          .pipe(Effect.orDie)
        return { embedded: 0, failed: rows.length, remaining: yield* pendingOf() }
      }

      for (let at = 0; at < rows.length; at++) {
        const row = rows[at]!
        // Delete-first keeps a failed→retried chunk from tripping the vec primary key.
        yield* exec(`DELETE FROM kb_chunk_vec WHERE chunk_id = ?`, [row.id])
        yield* exec(`INSERT INTO kb_chunk_vec (chunk_id, embedding, relation, doc_id, snippet) VALUES (?, ?, ?, ?, ?)`, [
          row.id,
          KbVecStore.vecBlob(vectors[at]!),
          row.relation,
          row.doc_id,
          row.text.slice(0, 200),
        ])
      }
      yield* db
        .update(KbChunkTable)
        .set({ embed_status: "done" })
        .where(
          inArray(
            KbChunkTable.id,
            rows.map((row) => row.id),
          ),
        )
        .pipe(Effect.orDie)
      yield* db
        .update(KbDocTable)
        .set({ embed_model: embedder.info.model })
        .where(
          inArray(KbDocTable.id, [...new Set(rows.map((row) => row.doc_id))]),
        )
        .pipe(Effect.orDie)
      return { embedded: rows.length, failed: 0, remaining: yield* pendingOf() }
    })

    const stats: Interface["stats"] = Effect.fn("KbDocs.stats")(function* () {
      const docs = yield* db
        .select({ id: KbDocTable.id })
        .from(KbDocTable)
        .where(isNull(KbDocTable.valid_to))
        .all()
        .pipe(Effect.orDie)
      const chunks = yield* db.select({ id: KbChunkTable.id, status: KbChunkTable.embed_status }).from(KbChunkTable).all().pipe(Effect.orDie)
      return {
        docs: docs.length,
        chunks: chunks.length,
        pendingChunks: chunks.filter((chunk) => chunk.status !== "done").length,
        vector: capability.vector && embedder !== undefined,
        ...(embedder === undefined ? {} : { embedModel: embedder.info.model }),
      }
    })

    return Service.of({ add, get, update, retract, search, drainEmbeddings, stats })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
