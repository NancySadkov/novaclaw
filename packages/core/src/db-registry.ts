export * as DbRegistry from "./db-registry"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "./database/database"

// The Registry app's backend (owner directive 2026-07-15): a Regedit-style browse/edit surface
// over the instance SQLite database — the Developer-mode re-homing of the raw `db` shell
// (todo.md tie-break #3: raw diagnostics live in Developer-mode apps, not terminal surfaces).
// Identifiers are validated against sqlite_master/PRAGMA table_info before interpolation;
// values always travel as bound parameters. Deletes honor foreign keys (cascades included) —
// this is honest database editing, gated to the Developer expertise level in the UI.

export class TableSummary extends Schema.Class<TableSummary>("DbRegistry.TableSummary")({
  name: Schema.String,
  rowCount: Schema.Number,
}) {}

export class TableRow extends Schema.Class<TableRow>("DbRegistry.TableRow")({
  rowid: Schema.Number,
  values: Schema.Record(Schema.String, Schema.Unknown),
}) {}

export class TablePage extends Schema.Class<TablePage>("DbRegistry.TablePage")({
  table: Schema.String,
  columns: Schema.Array(Schema.String),
  rowCount: Schema.Number,
  rows: Schema.Array(TableRow),
}) {}

export class RegistryError extends Schema.TaggedErrorClass<RegistryError>()("DbRegistry.RegistryError", {
  message: Schema.String,
}) {}

const tableNames = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = (yield* db
    .all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .pipe(Effect.orDie)) as { name: string }[]
  return rows.map((row) => row.name)
})

const assertTable = (table: string) =>
  Effect.gen(function* () {
    const names = yield* tableNames
    if (!names.includes(table)) return yield* new RegistryError({ message: `Unknown table: ${table}` })
    return table
  })

/**
 * Tables the Registry may BROWSE but must never WRITE.
 *
 * `migration` is the schema-migration journal (`database/migration.ts`) — one row per applied
 * migration id, and the only thing that tells the next boot what has already run. Every write to
 * it corrupts that answer, in both directions:
 *  - DELETE a row (or edit an `id`) → the migration REPLAYS on the next boot. Most migrations open
 *    with a `CREATE TABLE`/`ALTER TABLE`, which then throws on an object that already exists,
 *    inside `applyOnly`, which the Database layer `Effect.orDie`s — the instance does not start.
 *  - INSERT a fabricated id → a real migration looks already-applied and is SKIPPED, leaving the
 *    schema silently behind the code.
 *  - UPDATE `time_completed` → the least harmful, but it is the same row and the same class of
 *    foot-gun, and there is no legitimate reason to hand-edit it.
 * None of that is repairable from inside the product: it is precisely the edit that removes the
 * instance's ability to boot and therefore to repair itself (the instance is the trust boundary —
 * a Developer-mode surface may expose every dangerous edit EXCEPT that one). Reads stay open; this
 * gate is on writes only, so an operator can still inspect the journal to diagnose a bad upgrade.
 *
 * ⚠️ EXACT names, never a prefix or a substring match. `data_migration` (`data-migration.sql.ts`)
 * is an UNRELATED application table tracking data backfills and stays fully editable — the
 * "…still permits data_migration" negative control in `test/db-registry.test.ts` is what keeps
 * this honest.
 */
const READ_ONLY_TABLES: ReadonlySet<string> = new Set(["migration"])

/**
 * Tables an AGENT may browse but must never write, because `configure` is where their rules live.
 *
 * 🔴 **A raw row-write goes around the entire permission model.** Every config key carries an
 * operational / consequential / privileged classification (`config-tier.ts`), enforced at the
 * `configure` seam — so an agent denied a privileged card for `mcp` could simply write the
 * `runtime_setting` row instead and nothing would ask. Same class as a routing rule stranding
 * `configure` (fixed 2026-08-11): a surface that quietly undoes a permission model.
 *
 * ⚠️ **This binds the AGENT, not the Developer-mode UI** — see {@link Writer}. The migration journal
 * above is different in kind and binds BOTH: writing it can leave the instance unable to boot, which
 * is the one edit even an operator does not get, because it removes the machine's ability to repair
 * itself.
 *
 * ⚠️ These are the tables the config write router actually targets (`config-store-write.ts` —
 * `SETTINGS_KEYS` → `runtime_setting`, and one per `LAYERED_ARMS` entry). A table added there without
 * being added here is a hole, which is why `db-registry.test.ts` pins the set rather than trusting
 * this comment.
 */
const CONFIG_BACKED_TABLES: ReadonlySet<string> = new Set([
  "runtime_setting",
  "catalog_provider",
  "catalog_setting",
  "agent_config",
  "agent_setting",
  "command_config",
  "reference_config",
  "skill_config",
  "plugin_config",
])

/**
 * Who is asking. The Registry has two callers with genuinely different standing, and conflating them
 * would either strand the operator or hand the agent a permission bypass.
 *
 * · `"developer"` — the Developer-mode Registry app. A human on their own machine, past an expertise
 *   gate, with no permission model to circumvent: honest database editing is the whole point.
 * · `"agent"` — the `registry` tool. Its config reach is already governed, per key, at `configure`.
 */
export type Writer = "developer" | "agent"

/** `assertTable` plus the write gate: the table must exist, and this writer may write it. */
const assertWritable = (table: string, writer: Writer = "developer") =>
  Effect.gen(function* () {
    const name = yield* assertTable(table)
    if (READ_ONLY_TABLES.has(name))
      return yield* new RegistryError({
        message:
          `"${name}" is read-only: it is the schema-migration journal, and writing to it replays or ` +
          `skips a migration on the next boot, which can leave this instance unable to start. ` +
          `Browsing it is fine.`,
      })
    if (writer === "agent" && CONFIG_BACKED_TABLES.has(name))
      return yield* new RegistryError({
        message:
          `"${name}" holds configuration, so change it with the \`configure\` tool instead. Writing ` +
          `the row directly would skip the per-setting permission classification that \`configure\` ` +
          `enforces, which is the only thing standing between a model and a privileged setting. ` +
          `Browsing it is fine.`,
      })
    return name
  })

/** Exported for the ledger test that pins this set against the config write router's own targets. */
export const configBackedTables = (): ReadonlySet<string> => CONFIG_BACKED_TABLES

const tableColumns = (table: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = (yield* db.all(sql`SELECT name FROM pragma_table_info(${table}) ORDER BY cid`).pipe(Effect.orDie)) as {
      name: string
    }[]
    return rows.map((row) => row.name)
  })

export const tables = Effect.fn("DbRegistry.tables")(function* () {
  const { db } = yield* Database.Service
  const result: TableSummary[] = []
  for (const name of yield* tableNames) {
    // A table that cannot be counted must NOT take the whole listing down. MEASURED 2026-07-20: a dev
    // DB still carried `kb_chunk_vec`, a sqlite-vec VIRTUAL table created lazily by the retired KB-V
    // store and therefore never in any migration — once the extension stopped loading, `count(*)` threw
    // `no such module: vec0`, `orDie` propagated, and `/registry/tables` 500'd, so the Registry app
    // listed NOTHING. One unreadable table is a row with an unknown count, not a dead endpoint.
    const count = (yield* db
      .get(sql`SELECT count(*) AS count FROM ${sql.identifier(name)}`)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))) as { count: number } | undefined
    result.push(TableSummary.make({ name, rowCount: count?.count ?? 0 }))
  }
  return result
})

export const rows = Effect.fn("DbRegistry.rows")(function* (input: { table: string; limit?: number; offset?: number }) {
  const { db } = yield* Database.Service
  const table = yield* assertTable(input.table)
  const columns = yield* tableColumns(table)
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  const offset = Math.max(0, input.offset ?? 0)
  const count = (yield* db.get(sql`SELECT count(*) AS count FROM ${sql.identifier(table)}`).pipe(Effect.orDie)) as
    | { count: number }
    | undefined
  const raw = (yield* db
    .all(sql`SELECT rowid AS __rowid__, * FROM ${sql.identifier(table)} ORDER BY rowid LIMIT ${limit} OFFSET ${offset}`)
    .pipe(Effect.orDie)) as Record<string, unknown>[]
  return TablePage.make({
    table,
    columns,
    rowCount: count?.count ?? 0,
    rows: raw.map((row) => {
      const { __rowid__, ...values } = row
      return TableRow.make({ rowid: Number(__rowid__), values })
    }),
  })
})

export const updateRow = Effect.fn("DbRegistry.updateRow")(function* (input: {
  table: string
  rowid: number
  values: Record<string, unknown>
  /** Defaults to `developer`: the UI predates the distinction and must keep its full reach. */
  writer?: Writer
}) {
  const { db } = yield* Database.Service
  const table = yield* assertWritable(input.table, input.writer)
  const columns = yield* tableColumns(table)
  const entries = Object.entries(input.values).filter(([column]) => columns.includes(column))
  if (entries.length === 0) return yield* new RegistryError({ message: "No editable columns in the payload" })
  const assignments = entries.map(
    ([column, value]) => sql`${sql.identifier(column)} = ${value as string | number | null}`,
  )
  yield* db
    .run(sql`UPDATE ${sql.identifier(table)} SET ${sql.join(assignments, sql`, `)} WHERE rowid = ${input.rowid}`)
    .pipe(Effect.orDie)
})

/** Insert a row. Unlike update/delete (which target an existing rowid and rarely fail), an INSERT
 *  routinely hits real constraints — NOT NULL, UNIQUE, foreign keys — and those are USER errors on a
 *  hand-edited row, not defects. So the failure is mapped to a RegistryError the editor can show
 *  verbatim, rather than `orDie`ing the request. */
export const insertRow = Effect.fn("DbRegistry.insertRow")(function* (input: {
  table: string
  values: Record<string, unknown>
  writer?: Writer
}) {
  const { db } = yield* Database.Service
  const table = yield* assertWritable(input.table, input.writer)
  const columns = yield* tableColumns(table)
  // Same whitelist discipline as updateRow: unknown columns are dropped, never interpolated.
  const entries = Object.entries(input.values).filter(([column]) => columns.includes(column))
  if (entries.length === 0) return yield* new RegistryError({ message: "No known columns in the payload" })
  const names = entries.map(([column]) => sql.identifier(column))
  const values = entries.map(([, value]) => sql`${value as string | number | null}`)
  yield* db
    .run(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(names, sql`, `)}) VALUES (${sql.join(values, sql`, `)})`)
    .pipe(
      Effect.catch(
        (cause) =>
          new RegistryError({ message: `Insert failed: ${String((cause as { message?: string })?.message ?? cause)}` }),
      ),
    )
})

export const deleteRow = Effect.fn("DbRegistry.deleteRow")(function* (input: {
  table: string
  rowid: number
  writer?: Writer
}) {
  const { db } = yield* Database.Service
  const table = yield* assertWritable(input.table, input.writer)
  yield* db.run(sql`DELETE FROM ${sql.identifier(table)} WHERE rowid = ${input.rowid}`).pipe(Effect.orDie)
})
