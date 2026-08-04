import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801043513_add_session_context_budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`context_budget\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
