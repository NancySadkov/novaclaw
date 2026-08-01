export * as ConfigStoreFactory from "./config-store-factory"

import { eq } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { Cause, Effect, Exit, Schema, SchemaIssue } from "effect"
import { Log } from "@novaclaw/schema/log"
import type { Database } from "./database/database"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The seven config stores, collapsed onto factories (v0.2.0-prep Wave 4 item 10).
//
// `catalog-store.ts` used to say of itself: "the four layered stores are deliberate copies of one
// template (this file is that template) and share no helper module". This IS that helper module.
// Nothing about the SQL changed — the factories parameterise over the SAME Drizzle table objects,
// so `catalog_setting`, `agent_setting` and `runtime_setting` remain three physical tables and no
// migration is involved. What is collapsed is the WRAPPER code, which is the part that was copied.
//
// There are THREE row disciplines here, not two, and pretending otherwise would cost correctness:
//
//  · LAYERED (catalog · agent · command · reference) — one row per NAME holding an ORDERED list of
//    config fragments, decoded PER ROW. This is the only shape with a failure mode worth a factory:
//    see `makeLayeredStore`.
//  · KEY/VALUE (runtime_setting · catalog_setting · agent_setting) — one row per key holding one
//    whole JSON value. Three byte-identical tables; the roadmap counted one consumer, there are
//    three, because catalog's and agent's default-model/default-agent refs are exactly this shape
//    hand-rolled twice.
//  · LIST (skill · plugin) — an ordered set of rows keyed by their own identity string. This one
//    does NOT get a mould of its own: after `makeRowStore` below there is nothing left of it but a
//    row→entry mapping that differs in every store, and a factory whose every parameter is supplied
//    per call site is a rename, not an abstraction. The two list stores consume `makeRowStore`
//    directly and each keeps four one-line method bodies.
//
// ⚠️ SPANS ARE THE CALLER'S JOB. Every op below is a plain Effect, never an `Effect.fn`, so a store
// module wrapping it in `Effect.fn("AgentConfigStore.agents")` produces exactly ONE span per call —
// the same trace the hand-written stores produced. Naming an op here as well would nest a second
// span inside every read and silently change what the Debug app shows.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type Db = Database.Interface["db"]

/**
 * A row as this module handles it. Drizzle's builders are generic over the CONCRETE table type,
 * and a factory is by definition not — so every store's rows arrive here as plain records and the
 * type boundary is re-established at each store's own `Interface`, which is unchanged.
 */
type Row = Record<string, unknown>

/**
 * The four SQL statements every one of the seven stores issues, and nothing else.
 *
 * Shared so that the properties they carry are pinned once rather than seven times
 * (`packages/core/test/config-store-factory.test.ts`, ruling 1):
 *  · `isEmpty` is a bounded single-row read, never `count(*)` — these run on the boot path;
 *  · `selectAll` has no ORDER BY, i.e. rows come back in rowid (insertion) order, which the plugin
 *    and skill stores' documented "insertion order" contract depends on;
 *  · a delete targets the primary key column and only ever that.
 */
export interface RowStore {
  /** Every row, in rowid order. */
  readonly selectAll: () => Effect.Effect<Row[]>
  /** The row whose primary key is `key`, or `undefined`. */
  readonly selectOne: (key: string) => Effect.Effect<Row | undefined>
  /**
   * Insert `values`, or resolve the primary-key conflict. `set` given → update those columns
   * (last write wins); `set` omitted → do nothing (the row's identity IS its content).
   */
  readonly upsert: (values: Row, set?: Row) => Effect.Effect<void>
  /** Delete the row whose primary key is `key`. */
  readonly deleteOne: (key: string) => Effect.Effect<void>
  /** True when the table holds no rows. */
  readonly isEmpty: () => Effect.Effect<boolean>
}

/**
 * Drizzle's query builders are generic over the CONCRETE table type; a factory is by definition not.
 * These two adapters are where that is reconciled, and they are the ONLY casts in this module — the
 * shape of every value they carry is checked at the call site, where the real table is in scope.
 */
const rowsOf = (query: unknown) => query as Effect.Effect<Row[], unknown>
const rowOf = (query: unknown) => query as Effect.Effect<Row | undefined, unknown>
const ranOf = (query: unknown) => (query as Effect.Effect<unknown, unknown>).pipe(Effect.orDie, Effect.asVoid)

export const makeRowStore = (db: Db, table: SQLiteTable, keyColumn: SQLiteColumn): RowStore => ({
  selectAll: () => rowsOf(db.select().from(table).all()).pipe(Effect.orDie),
  selectOne: (key) => rowOf(db.select().from(table).where(eq(keyColumn, key)).get()).pipe(Effect.orDie),
  upsert: (values, set) => {
    // `never` is assignable to Drizzle's per-table `SQLiteInsertValue<TTable>` /
    // `SQLiteUpdateSetSource<TTable>`, neither of which can be satisfied generically.
    const insert = db.insert(table).values(values as never)
    return ranOf(
      set === undefined
        ? insert.onConflictDoNothing().run()
        : insert.onConflictDoUpdate({ target: keyColumn, set: set as never }).run(),
    )
  },
  deleteOne: (key) => ranOf(db.delete(table).where(eq(keyColumn, key)).run()),
  isEmpty: () =>
    // A single-row read, not `count(*)`: these stores are resolved at every location boot and the
    // only question asked is "is there anything here at all" (the one-time jsonc seed gate).
    rowOf(db.select().from(table).get())
      .pipe(Effect.orDie)
      .pipe(Effect.map((row) => row === undefined)),
})

/**
 * Format an Effect decode failure into a short human-readable reason — the same shape
 * `settings-config-seed.ts` uses, so every "a stored config row could not be read" notice reads the
 * same way to a user. Was copied verbatim into all four layered stores; now it exists once.
 */
export function decodeFailureReason(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  if (Schema.isSchemaError(error)) {
    const messages = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => issue.message)
    if (messages.length > 0) return messages.join("; ")
  }
  return String(error)
}

/**
 * How one layered store names itself in the operator-facing warning. Spelled out rather than
 * derived: the reference store is a "reference alias", not merely a generic reference.
 */
export interface LayeredReport {
  /** The bounded entity kind whose stored rows are being decoded. */
  readonly kind: string
  /** The SQLite table an operator opens in the Registry app to fix the row. */
  readonly table: string
}

/**
 * The trace an operator can find: a WARN in the instance log (Developer mode → Debug app → error
 * log), naming every row that was dropped and why — the same reporting `config.ts` does for an
 * unreadable settings row. Deduped against `reported` for the life of the layer so a caller that
 * reads per-turn cannot turn one corrupt row into a log flood.
 */
export const warnUnreadable = (reported: Set<string>, skipped: readonly string[], report: LayeredReport) =>
  Effect.suspend(() => {
    const fresh = skipped.filter((line) => !reported.has(line))
    if (fresh.length === 0) return Effect.void
    for (const line of fresh) reported.add(line)
    return Log.event("config.store.read.degraded", {
      "config.kind": report.kind,
      "config.table": report.table,
      "config.invalid": fresh.length,
      "config.rows": fresh.map((line) => `  - ${line}`).join("\n"),
    })
  })

/** The read/write half every layered store exposes under its own nouns. */
export interface LayeredStore<Item> {
  /** Every readable row's ordered layers, keyed by name (apply in order to merge). */
  readonly all: () => Effect.Effect<Record<string, Item[]>>
  /** Insert or replace the full ordered layer list for one name. */
  readonly setLayers: (name: string, layers: readonly Item[]) => Effect.Effect<void>
  /** Remove one name's stored config. */
  readonly remove: (name: string) => Effect.Effect<void>
  /** True when nothing is stored (gates the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export interface LayeredSpec<Item> {
  readonly db: Db
  /** The Drizzle table — one row per name, with a `layers` JSON column. */
  readonly table: SQLiteTable
  /** That table's primary-key column object … */
  readonly keyColumn: SQLiteColumn
  /** … and its NAME, which is what the decoded record is keyed by (`id` for catalog, else `name`). */
  readonly keyName: string
  /**
   * `Schema.decodeUnknownExit(Schema.Array(<the layer schema>))`. An Exit, never a sync decode:
   * `decodeUnknownSync` THROWS, and this runs inside an `Effect.fn` on a `makeGlobalNode` service
   * that every location boot resolves.
   */
  readonly decode: (value: unknown) => Exit.Exit<readonly Item[], unknown>
  readonly report: LayeredReport
}

/**
 * The layered store: one row per name holding an ordered list of config fragments.
 *
 * ⚠️ THE PER-ROW DECODE IS THE POINT OF THIS FUNCTION, not boilerplate it happens to carry.
 * One malformed `layers` blob used to be a DEFECT that killed the whole read — every provider /
 * agent / command / alias vanished and the boot died with it. Standing decision 3 (ruling 2): a
 * read never destroys, and an unavailable subsystem NAMES itself instead of rendering empty.
 * Rendering empty is especially treacherous for the catalog, where a zero-provider result is a
 * SUPPORTED first-run state and would route the user to "Add models" instead of telling them their
 * catalog is broken.
 *
 * ⚠️ And granularity is the ROW, never the individual layer. Layers merge in order with later ones
 * overriding earlier ones, so silently dropping one layer out of the middle yields a DIFFERENT
 * entity than the user configured — a corrected baseURL reverts to the stale one, a restricted
 * agent becomes unrestricted, an alias resolves to the wrong repository. Quietly wrong is worse
 * than honestly missing. `packages/core/test/config-store-factory.test.ts` pins both properties for
 * all four stores at once, which is the thing a shared factory buys that four copies could not.
 */
export const makeLayeredStore = <Item>(spec: LayeredSpec<Item>): LayeredStore<Item> => {
  const rows = makeRowStore(spec.db, spec.table, spec.keyColumn)
  // One Set per layer build, exactly as each hand-written store held: the dedup window is the life
  // of the service, so a hot per-turn reader cannot turn one corrupt row into a log flood.
  const reported = new Set<string>()
  return {
    all: () =>
      Effect.gen(function* () {
        const result: Record<string, Item[]> = {}
        const skipped: string[] = []
        for (const row of yield* rows.selectAll()) {
          const name = row[spec.keyName] as string
          const decoded = spec.decode(row.layers)
          if (Exit.isSuccess(decoded)) {
            result[name] = [...decoded.value]
            continue
          }
          skipped.push(`${name}: ${decodeFailureReason(decoded.cause)}`)
        }
        if (skipped.length > 0) yield* warnUnreadable(reported, skipped, spec.report)
        return result
      }),
    setLayers: (name, layers) => rows.upsert({ [spec.keyName]: name, layers }, { layers }),
    remove: (name) => rows.deleteOne(name),
    isEmpty: () => rows.isEmpty(),
  }
}

/**
 * The key/value store over a `(key text primary key, value text json)` table.
 *
 * Three tables have exactly that shape — `runtime_setting`, `catalog_setting`, `agent_setting` —
 * and all three are served from here. Merging them PHYSICALLY into one table is a separate change
 * that would need a migration; this is the TypeScript half, which needs none.
 */
export interface KeyValueStore<Value> {
  /** Every stored pair, keyed by key. */
  readonly all: () => Effect.Effect<Record<string, Value>>
  /** One value, or `undefined` when no row exists. */
  readonly get: (key: string) => Effect.Effect<Value | undefined>
  /** Insert or replace one key's whole value (no layers — last write wins). */
  readonly set: (key: string, value: Value) => Effect.Effect<void>
  /**
   * Write only when the ROW is absent — not when the value is falsy. The distinction is
   * load-bearing: a stored empty string is still a value the user chose, and treating it as absent
   * would let a re-run of the transitional jsonc seed clobber it.
   */
  readonly setIfAbsent: (key: string, value: Value) => Effect.Effect<void>
  /**
   * Delete the ROW, not the value. An empty-string default would still be a value and would block
   * `setIfAbsent` from ever seeding again (the `clearDefault` contract).
   */
  readonly remove: (key: string) => Effect.Effect<void>
  /** True when nothing is stored (gates the one-time jsonc seed). */
  readonly isEmpty: () => Effect.Effect<boolean>
}

export const makeKeyValueStore = <Value = unknown>(spec: {
  readonly db: Db
  /** A `(key, value)` table. The column names are fixed — that is what makes these three one shape. */
  readonly table: SQLiteTable
  readonly keyColumn: SQLiteColumn
}): KeyValueStore<Value> => {
  const rows = makeRowStore(spec.db, spec.table, spec.keyColumn)
  const put = (key: string, value: Value) => rows.upsert({ key, value }, { value })
  return {
    all: () =>
      Effect.gen(function* () {
        const result: Record<string, Value> = {}
        for (const row of yield* rows.selectAll()) result[row.key as string] = row.value as Value
        return result
      }),
    get: (key) => rows.selectOne(key).pipe(Effect.map((row) => row?.value as Value | undefined)),
    set: put,
    setIfAbsent: (key, value) =>
      Effect.gen(function* () {
        const existing = yield* rows.selectOne(key)
        if (!existing) yield* put(key, value)
      }),
    remove: (key) => rows.deleteOne(key),
    isEmpty: () => rows.isEmpty(),
  }
}
