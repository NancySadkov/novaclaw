export * as Kb from "./kb"

// KB-A — the knowledge-base facade + in-house PoC store (the keystone of the KB
// track). ONE stable API (query/add/update/retract/populate/backup/clear/stats);
// by default it is served by this small Drizzle/SQLite store living in the main
// database, and a future `kb.url` config points the SAME API at a proper backend
// (Datalevin on the Spark/NAS) — nothing above the API can tell the difference.
//
// Write discipline (the research verdicts baked in, non-negotiable):
//   - every fact carries PROVENANCE (source, agent, confidence) + timestamps;
//   - `update` and `retract` are DATED MOVES, never destructive overwrites: an
//     update stamps valid_to + superseded_by on the old row and inserts a new
//     one (a correction is a chain; a "death" is a valid_to stamp; a flip-war is
//     structurally impossible);
//   - agent-written facts stay distinguishable from imported/curated ones
//     FOREVER via `relation` ("staged" vs "core") — the ingestion-hallucination
//     mitigation;
//   - `clear` is the only true delete, and `backup` exists precisely so it is safe.

import { and, asc, eq, isNull, type SQL } from "drizzle-orm"
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Context, Effect, Layer, Schema } from "effect"
import { ascending } from "@novaclaw/schema/identifier"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"

// --- storage ------------------------------------------------------------------

export const KbFactTable = sqliteTable(
  "kb_fact",
  {
    id: text().primaryKey(),
    subject: text().notNull(),
    predicate: text().notNull(),
    object: text().notNull(),
    relation: text().$type<"core" | "staged">().notNull(),
    source: text(),
    agent: text(),
    confidence: real(),
    valid_from: integer().notNull(),
    valid_to: integer(),
    superseded_by: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("kb_fact_subject_idx").on(table.subject, table.valid_to),
    index("kb_fact_predicate_idx").on(table.predicate, table.valid_to),
    index("kb_fact_object_idx").on(table.object, table.valid_to),
  ],
)

// --- wire schemas ---------------------------------------------------------------

export const ID = Schema.String.check(Schema.isStartsWith("fct_")).pipe(Schema.brand("Kb.FactID"))
export type ID = typeof ID.Type
export const createID = (): ID => ("fct_" + ascending()) as ID

export const Relation = Schema.Literals(["core", "staged"])
export type Relation = typeof Relation.Type

export const Fact = Schema.Struct({
  id: ID,
  subject: Schema.String,
  predicate: Schema.String,
  object: Schema.String,
  relation: Relation,
  source: Schema.String.pipe(Schema.optional),
  agent: Schema.String.pipe(Schema.optional),
  confidence: Schema.Finite.pipe(Schema.optional),
  validFrom: Schema.Finite,
  validTo: Schema.Finite.pipe(Schema.optional),
  supersededBy: Schema.String.pipe(Schema.optional),
  timeCreated: Schema.Finite,
}).annotate({ identifier: "Kb.Fact" })
export type Fact = typeof Fact.Type

export const AddInput = Schema.Struct({
  subject: Schema.String.check(Schema.isMinLength(1)),
  predicate: Schema.String.check(Schema.isMinLength(1)),
  object: Schema.String.check(Schema.isMinLength(1)),
  relation: Relation.pipe(Schema.optional),
  source: Schema.String.pipe(Schema.optional),
  agent: Schema.String.pipe(Schema.optional),
  confidence: Schema.Finite.pipe(Schema.optional),
}).annotate({ identifier: "Kb.AddInput" })
export type AddInput = typeof AddInput.Type

export const QueryInput = Schema.Struct({
  subject: Schema.String.pipe(Schema.optional),
  predicate: Schema.String.pipe(Schema.optional),
  object: Schema.String.pipe(Schema.optional),
  relation: Relation.pipe(Schema.optional),
  includeRetracted: Schema.Boolean.pipe(Schema.optional),
  limit: Schema.Finite.pipe(Schema.optional),
}).annotate({ identifier: "Kb.QueryInput" })
export type QueryInput = typeof QueryInput.Type

export const UpdateInput = Schema.Struct({
  object: Schema.String.pipe(Schema.optional),
  confidence: Schema.Finite.pipe(Schema.optional),
  source: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Kb.UpdateInput" })
export type UpdateInput = typeof UpdateInput.Type

export const Stats = Schema.Struct({
  active: Schema.Finite,
  retracted: Schema.Finite,
  total: Schema.Finite,
  core: Schema.Finite,
  staged: Schema.Finite,
  backend: Schema.String,
}).annotate({ identifier: "Kb.Stats" })
export type Stats = typeof Stats.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Kb.NotFoundError", {
  id: Schema.String,
}) {}

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100

type Row = typeof KbFactTable.$inferSelect

const toFact = (row: Row): Fact =>
  ({
    id: row.id as ID,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    relation: row.relation,
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.agent !== null ? { agent: row.agent } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    validFrom: row.valid_from,
    ...(row.valid_to !== null ? { validTo: row.valid_to } : {}),
    ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
    timeCreated: row.time_created,
  }) as Fact

// --- service --------------------------------------------------------------------

export interface Interface {
  readonly add: (input: AddInput) => Effect.Effect<Fact>
  readonly query: (input: QueryInput) => Effect.Effect<Fact[]>
  readonly get: (id: string) => Effect.Effect<Fact | undefined>
  readonly update: (id: string, patch: UpdateInput) => Effect.Effect<Fact, NotFoundError>
  readonly retract: (id: string) => Effect.Effect<Fact, NotFoundError>
  readonly populate: (facts: readonly AddInput[]) => Effect.Effect<{ inserted: number }>
  readonly backup: () => Effect.Effect<Fact[]>
  readonly clear: () => Effect.Effect<{ deleted: number }>
  readonly stats: () => Effect.Effect<Stats>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Kb") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const insertRow = (input: AddInput, now: number) => {
      const id = createID()
      return db
        .insert(KbFactTable)
        .values({
          id,
          subject: input.subject,
          predicate: input.predicate,
          object: input.object,
          relation: input.relation ?? "staged",
          source: input.source ?? null,
          agent: input.agent ?? null,
          confidence: input.confidence ?? null,
          valid_from: now,
          valid_to: null,
          superseded_by: null,
          time_created: now,
        })
        .returning()
        .get()
        .pipe(Effect.orDie)
    }

    const add: Interface["add"] = Effect.fn("Kb.add")(function* (input) {
      return toFact(yield* insertRow(input, Date.now()))
    })

    const query: Interface["query"] = Effect.fn("Kb.query")(function* (input) {
      const conditions: SQL[] = []
      if (input.subject !== undefined) conditions.push(eq(KbFactTable.subject, input.subject))
      if (input.predicate !== undefined) conditions.push(eq(KbFactTable.predicate, input.predicate))
      if (input.object !== undefined) conditions.push(eq(KbFactTable.object, input.object))
      if (input.relation !== undefined) conditions.push(eq(KbFactTable.relation, input.relation))
      if (input.includeRetracted !== true) conditions.push(isNull(KbFactTable.valid_to))
      const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
      const rows = yield* db
        .select()
        .from(KbFactTable)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(KbFactTable.time_created), asc(KbFactTable.id))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(toFact)
    })

    const get: Interface["get"] = Effect.fn("Kb.get")(function* (id) {
      const row = yield* db.select().from(KbFactTable).where(eq(KbFactTable.id, id)).get().pipe(Effect.orDie)
      return row ? toFact(row) : undefined
    })

    const requireActive = Effect.fnUntraced(function* (id: string) {
      const row = yield* db.select().from(KbFactTable).where(eq(KbFactTable.id, id)).get().pipe(Effect.orDie)
      if (!row || row.valid_to !== null) return yield* new NotFoundError({ id })
      return row
    })

    const update: Interface["update"] = Effect.fn("Kb.update")(function* (id, patch) {
      const row = yield* requireActive(id)
      const now = Date.now()
      // Audit chain: the old row is stamped, never rewritten.
      const next = yield* insertRow(
        {
          subject: row.subject,
          predicate: row.predicate,
          object: patch.object ?? row.object,
          relation: row.relation,
          ...(patch.source ?? row.source ?? undefined ? { source: patch.source ?? row.source ?? undefined } : {}),
          ...(row.agent !== null ? { agent: row.agent } : {}),
          ...((patch.confidence ?? row.confidence ?? undefined) !== undefined
            ? { confidence: patch.confidence ?? row.confidence ?? undefined }
            : {}),
        },
        now,
      )
      yield* db
        .update(KbFactTable)
        .set({ valid_to: now, superseded_by: next.id })
        .where(eq(KbFactTable.id, id))
        .run()
        .pipe(Effect.orDie)
      return toFact(next)
    })

    const retract: Interface["retract"] = Effect.fn("Kb.retract")(function* (id) {
      const row = yield* requireActive(id)
      const now = Date.now()
      yield* db.update(KbFactTable).set({ valid_to: now }).where(eq(KbFactTable.id, id)).run().pipe(Effect.orDie)
      return toFact({ ...row, valid_to: now })
    })

    const populate: Interface["populate"] = Effect.fn("Kb.populate")(function* (facts) {
      const now = Date.now()
      for (const fact of facts) yield* insertRow(fact, now)
      return { inserted: facts.length }
    })

    const backup: Interface["backup"] = Effect.fn("Kb.backup")(function* () {
      const rows = yield* db
        .select()
        .from(KbFactTable)
        .orderBy(asc(KbFactTable.time_created), asc(KbFactTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toFact)
    })

    const clear: Interface["clear"] = Effect.fn("Kb.clear")(function* () {
      const rows = yield* db.select({ id: KbFactTable.id }).from(KbFactTable).all().pipe(Effect.orDie)
      yield* db.delete(KbFactTable).run().pipe(Effect.orDie)
      return { deleted: rows.length }
    })

    const stats: Interface["stats"] = Effect.fn("Kb.stats")(function* () {
      const rows = yield* db
        .select({ relation: KbFactTable.relation, valid_to: KbFactTable.valid_to })
        .from(KbFactTable)
        .all()
        .pipe(Effect.orDie)
      const active = rows.filter((row) => row.valid_to === null).length
      return {
        active,
        retracted: rows.length - active,
        total: rows.length,
        core: rows.filter((row) => row.relation === "core").length,
        staged: rows.filter((row) => row.relation === "staged").length,
        backend: "builtin-sqlite",
      }
    })

    return Service.of({ add, query, get, update, retract, populate, backup, clear, stats })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
