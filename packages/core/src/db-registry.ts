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

const tableColumns = (table: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = (yield* db
      .all(sql`SELECT name FROM pragma_table_info(${table}) ORDER BY cid`)
      .pipe(Effect.orDie)) as { name: string }[]
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

export const rows = Effect.fn("DbRegistry.rows")(function* (input: {
  table: string
  limit?: number
  offset?: number
}) {
  const { db } = yield* Database.Service
  const table = yield* assertTable(input.table)
  const columns = yield* tableColumns(table)
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  const offset = Math.max(0, input.offset ?? 0)
  const count = (yield* db
    .get(sql`SELECT count(*) AS count FROM ${sql.identifier(table)}`)
    .pipe(Effect.orDie)) as { count: number } | undefined
  const raw = (yield* db
    .all(
      sql`SELECT rowid AS __rowid__, * FROM ${sql.identifier(table)} ORDER BY rowid LIMIT ${limit} OFFSET ${offset}`,
    )
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
}) {
  const { db } = yield* Database.Service
  const table = yield* assertTable(input.table)
  const columns = yield* tableColumns(table)
  const entries = Object.entries(input.values).filter(([column]) => columns.includes(column))
  if (entries.length === 0) return yield* new RegistryError({ message: "No editable columns in the payload" })
  const assignments = entries.map(([column, value]) => sql`${sql.identifier(column)} = ${value as string | number | null}`)
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
}) {
  const { db } = yield* Database.Service
  const table = yield* assertTable(input.table)
  const columns = yield* tableColumns(table)
  // Same whitelist discipline as updateRow: unknown columns are dropped, never interpolated.
  const entries = Object.entries(input.values).filter(([column]) => columns.includes(column))
  if (entries.length === 0) return yield* new RegistryError({ message: "No known columns in the payload" })
  const names = entries.map(([column]) => sql.identifier(column))
  const values = entries.map(([, value]) => sql`${value as string | number | null}`)
  yield* db
    .run(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(names, sql`, `)}) VALUES (${sql.join(values, sql`, `)})`)
    .pipe(Effect.catch((cause) => new RegistryError({ message: `Insert failed: ${String((cause as { message?: string })?.message ?? cause)}` })))
})

export const deleteRow = Effect.fn("DbRegistry.deleteRow")(function* (input: { table: string; rowid: number }) {
  const { db } = yield* Database.Service
  const table = yield* assertTable(input.table)
  yield* db.run(sql`DELETE FROM ${sql.identifier(table)} WHERE rowid = ${input.rowid}`).pipe(Effect.orDie)
})
