import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813224857_add_session_execution_served_by",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_execution\` ADD \`served_by\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
