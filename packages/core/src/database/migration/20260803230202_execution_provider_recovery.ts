import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803230202_execution_provider_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_execution\` ADD \`provider_recovery\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
