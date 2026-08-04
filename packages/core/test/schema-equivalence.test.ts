import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { migrations } from "@novaclaw/core/database/migration.gen"
import schema from "@novaclaw/core/database/schema.gen"

/**
 * Fresh install vs upgrade: the two schema paths must agree.
 *
 * A NovaClaw database is built one of two ways (`database/migration.ts`):
 *   - FRESH  — an empty file gets `schema.gen.ts`'s `up(tx)` in one transaction, then every migration
 *              id is stamped into `migration` as already-done (`apply`, the `tables.length === 0` arm).
 *   - UPGRADE — an existing user database runs the untracked tail of `migration.gen.ts` (`applyOnly`).
 *
 * Nothing in the tree compared their RESULTS until this file. `script/migration.ts --check` cannot:
 * it diffs three views of the *declared* schema (the drizzle snapshot, `schema.gen.ts`, the migration
 * registry listing) and never executes a single statement, so a migration chain that builds a
 * materially different database than `schema.gen.ts` is invisible to it. That gap is precisely what
 * v0.2.0 Wave 0 / B5 was about, and it is the class of bug that kills boot on upgrade only — i.e. only
 * for users who already have data.
 *
 * So: build both, in `:memory:`, and diff the actual SQLite catalogue.
 */

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

type Db = EffectDrizzleSqlite.EffectSQLiteDatabase

type Shape = {
  /** `sqlite_master` rows as `"<type> <name> on <tbl_name>"`. */
  objects: string[]
  /** table name -> its columns, as a SET of normalized descriptions. */
  columns: Record<string, string[]>
  /** table name -> its indexes, as a SET of normalized descriptions. */
  indexes: Record<string, string[]>
  /** table name -> its foreign keys, as a SET of normalized descriptions. */
  foreignKeys: Record<string, string[]>
}

/**
 * `migration` is the migration bookkeeping table: `applyOnly` creates it, the raw `schema.gen.ts`
 * transaction does not, so it is present on one side by construction and says nothing about drift.
 * `__drizzle_migrations` is its dead predecessor, imported from rather than created.
 */
const BOOKKEEPING = new Set(["migration", "__drizzle_migrations"])

const readShape = (db: Db) =>
  Effect.gen(function* () {
    const master = yield* db.all<{ type: string; name: string; tbl_name: string }>(
      sql`SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    const relevant = master.filter((row) => !BOOKKEEPING.has(row.tbl_name))
    const shape: Shape = {
      objects: relevant.map((row) => `${row.type} ${row.name} on ${row.tbl_name}`).sort(),
      columns: {},
      indexes: {},
      foreignKeys: {},
    }

    for (const table of relevant.filter((row) => row.type === "table").map((row) => row.name)) {
      const columns = yield* db.all<{
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }>(sql`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${table})`)
      // Compared as a SET, deliberately. Column ORDER legitimately differs between the two paths: a
      // fresh `CREATE TABLE` lists columns in declaration order, while the chain reaches the same
      // table by `ALTER TABLE ... ADD COLUMN`, which appends. Ordinal position is not part of the
      // contract; the set of (name, type, notnull, default, pk) tuples is.
      shape.columns[table] = columns
        .map((col) => `${col.name} ${col.type} notnull=${col.notnull} default=${col.dflt_value ?? "-"} pk=${col.pk}`)
        .sort()

      const list = yield* db.all<{ name: string; unique: number; origin: string; partial: number }>(
        sql`SELECT name, "unique", origin, partial FROM pragma_index_list(${table})`,
      )
      const indexes: string[] = []
      for (const index of list) {
        const info = yield* db.all<{ name: string | null }>(
          sql`SELECT name FROM pragma_index_info(${index.name}) ORDER BY seqno`,
        )
        // Implicit indexes (UNIQUE / PRIMARY KEY constraints) are named `sqlite_autoindex_<table>_<n>`,
        // where <n> is assignment order and so is NOT stable between a fresh CREATE and an
        // ALTER-rebuilt table. Rather than dropping them — which would blind the test to a lost UNIQUE
        // constraint — identify them by what they constrain (origin + columns) instead of by name.
        const name = index.name.startsWith("sqlite_autoindex_") ? `<auto ${index.origin}>` : index.name
        const columnList = info.map((column) => column.name ?? "<expr>").join(",")
        indexes.push(`${name} unique=${index.unique} partial=${index.partial} (${columnList})`)
      }
      shape.indexes[table] = indexes.sort()

      // Neither sqlite_master's normalized SQL nor table_info exposes referential actions, so a
      // migration that rebuilt a table and quietly lost an `ON DELETE CASCADE` would otherwise be
      // invisible to this comparison.
      const foreignKeys = yield* db.all<{
        table: string
        from: string
        to: string | null
        on_update: string
        on_delete: string
      }>(sql`SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(${table})`)
      shape.foreignKeys[table] = foreignKeys
        .map((fk) => `${fk.from} -> ${fk.table}.${fk.to ?? "<rowid>"} update=${fk.on_update} delete=${fk.on_delete}`)
        .sort()
    }

    return shape
  })

const shapeOf = (apply: (db: Db) => Effect.Effect<unknown, unknown, never>) =>
  run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* apply(db)
      return yield* readShape(db)
    }),
  )

/** The FRESH-install path: exactly what `apply` runs against an empty file, minus the id stamping. */
const applyFresh = (db: Db) => db.transaction((tx) => schema.up(tx))

/**
 * The UPGRADE path: the tracked chain, start to finish.
 *
 * ⚠️ It must be `applyOnly(db, migrations)`, NOT `apply(db)`. On an empty database `apply` takes the
 * fresh-install arm and runs `schema.gen.ts` — so using it here would compare `schema.gen.ts` with
 * itself and pass unconditionally.
 */
const applyChain = (db: Db) => DatabaseMigration.applyOnly(db, migrations)

const FRESH = "fresh-only"
const CHAIN = "chain-only"

const onlyIn = (side: string, label: string, left: string[], right: string[]) => {
  const other = new Set(right)
  return left.filter((entry) => !other.has(entry)).map((entry) => `${side} | ${label} | ${entry}`)
}

/**
 * A readable, actionable diff: one line per differing object / column / index / foreign key, naming
 * the side it is missing from. `fresh-only` = built by `schema.gen.ts` but never reached by the chain
 * (an upgraded install will be missing it); `chain-only` = the mirror (a fresh install lacks it).
 */
const differences = (fresh: Shape, chain: Shape) => {
  const out = [
    ...onlyIn(FRESH, "object", fresh.objects, chain.objects),
    ...onlyIn(CHAIN, "object", chain.objects, fresh.objects),
  ]
  for (const table of [...new Set([...Object.keys(fresh.columns), ...Object.keys(chain.columns)])].sort()) {
    // A table missing from one side entirely is already reported above; listing all 40 of its columns
    // again would bury the finding.
    if (!(table in fresh.columns) || !(table in chain.columns)) continue
    out.push(
      ...onlyIn(FRESH, `${table} column`, fresh.columns[table], chain.columns[table]),
      ...onlyIn(CHAIN, `${table} column`, chain.columns[table], fresh.columns[table]),
      ...onlyIn(FRESH, `${table} index`, fresh.indexes[table], chain.indexes[table]),
      ...onlyIn(CHAIN, `${table} index`, chain.indexes[table], fresh.indexes[table]),
      ...onlyIn(FRESH, `${table} foreign key`, fresh.foreignKeys[table], chain.foreignKeys[table]),
      ...onlyIn(CHAIN, `${table} foreign key`, chain.foreignKeys[table], fresh.foreignKeys[table]),
    )
  }
  return out
}

/**
 * Divergences that exist today, are understood, and are NOT worth a schema-rewriting migration.
 *
 * This list may only ever SHRINK — the third test below fails if an entry here stops being observed,
 * so a fix (or a table deletion) forces the entry to be deleted with it rather than rotting.
 *
 * `account_state.id`: a drizzle-kit CODEGEN change, not a declaration change. `AccountStateTable`
 * (`src/account/sql.ts:16`) declares `integer().primaryKey()`. The 2026-02-28 migration
 * (`20260228203230_blue_harpoon`) was emitted by an older drizzle-kit as `integer PRIMARY KEY NOT
 * NULL`; today's drizzle-kit (1.0.0-rc.2) emits `integer PRIMARY KEY`. The difference is inert in
 * SQLite — on a rowid alias, `INSERT ... (id) VALUES (NULL)` auto-assigns the rowid with or without
 * the NOT NULL (verified directly) — and `AccountStateTable` currently has no reader or writer
 * anywhere in `src`; it belongs to the Console/org subsystem that v0.2.0 Wave 4 slates for deletion.
 * Delete these two lines when that table goes, or when a migration rebuilds it.
 */
const KNOWN_DIVERGENCES = [
  "fresh-only | account_state column | id INTEGER notnull=0 default=- pk=1",
  "chain-only | account_state column | id INTEGER notnull=1 default=- pk=1",
]

let cached: Promise<{ fresh: Shape; chain: Shape }> | undefined
const shapes = () =>
  (cached ??= Promise.all([shapeOf(applyFresh), shapeOf(applyChain)]).then(([fresh, chain]) => ({ fresh, chain })))

describe("schema equivalence", () => {
  // Guards the failure mode this whole file is exposed to: if either read returned nothing, every set
  // difference below would be empty and the equivalence test would pass while proving nothing.
  test("both paths actually built a database", async () => {
    const { fresh, chain } = await shapes()
    expect(Object.keys(fresh.columns).length).toBeGreaterThan(30)
    expect(Object.keys(chain.columns).length).toBeGreaterThan(30)
    expect(Object.keys(fresh.columns)).toContain("session")
    expect(Object.keys(chain.columns)).toContain("session")
    expect(fresh.columns["session"].length).toBeGreaterThan(30)
    expect(chain.columns["session"].length).toBeGreaterThan(30)
    expect(fresh.indexes["session"].length).toBeGreaterThan(0)
    expect(chain.indexes["session"].length).toBeGreaterThan(0)
    expect(Object.values(fresh.foreignKeys).flat().length).toBeGreaterThan(0)
    expect(Object.values(chain.foreignKeys).flat().length).toBeGreaterThan(0)
  })

  test("a fresh install and the migration chain produce the same schema", async () => {
    const { fresh, chain } = await shapes()
    const known = new Set(KNOWN_DIVERGENCES)
    const unexpected = differences(fresh, chain).filter((line) => !known.has(line))
    // Compared as a joined string so the report prints in full and each line names its own object.
    expect(unexpected.join("\n")).toBe("")
  })

  test("every known divergence is still real", async () => {
    const { fresh, chain } = await shapes()
    const observed = new Set(differences(fresh, chain))
    const stale = KNOWN_DIVERGENCES.filter((line) => !observed.has(line))
    expect(stale.join("\n")).toBe("")
  })
})
