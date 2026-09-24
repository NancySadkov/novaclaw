import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import * as InstancePath from "../instance-path"
import { Scratch } from "../../scratch"

const jsonColumns = [
  ["agent_config", "layers"],
  ["catalog_provider", "layers"],
  ["command_config", "layers"],
  ["reference_config", "layers"],
  ["runtime_setting", "value"],
  ["catalog_setting", "value"],
  ["agent_setting", "value"],
] as const

export default {
  id: "20260924180000_portable_instance_paths",
  up(tx) {
    return Effect.gen(function* () {
      for (const [table, column] of jsonColumns) {
        const rows = yield* tx.all<{ rowid: number; value: string }>(
          sql`SELECT rowid, ${sql.identifier(column)} AS value FROM ${sql.identifier(table)}`,
        )
        for (const row of rows) {
          let value: unknown
          try {
            value = JSON.parse(row.value)
          } catch {
            continue
          }
          const normalized = InstancePath.mapValues(value, InstancePath.store, InstancePath.preserveProjectDirectory)
          const stored = JSON.stringify(normalized)
          if (stored !== row.value)
            yield* tx.run(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${stored} WHERE rowid = ${row.rowid}`)
        }
      }

      const sessions = yield* tx.all<{ rowid: number; directory: string }>(sql`SELECT rowid, directory FROM session`)
      for (const session of sessions) {
        if (!Scratch.contains(session.directory)) continue
        const stored = InstancePath.store(session.directory)
        if (stored !== session.directory)
          yield* tx.run(sql`UPDATE session SET directory = ${stored} WHERE rowid = ${session.rowid}`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
