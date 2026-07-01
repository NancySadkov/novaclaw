import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260701131350_add_session_result",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`result\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
