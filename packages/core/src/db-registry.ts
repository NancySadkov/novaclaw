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
    const count = (yield* db
      .get(sql`SELECT count(*) AS count FROM ${sql.identifier(name)}`)
      .pipe(Effect.orDie)) as { count: number } | undefined
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

export const deleteRow = Effect.fn("DbRegistry.deleteRow")(function* (input: { table: string; rowid: number }) {
  const { db } = yield* Database.Service
  const table = yield* assertTable(input.table)
  yield* db.run(sql`DELETE FROM ${sql.identifier(table)} WHERE rowid = ${input.rowid}`).pipe(Effect.orDie)
})
