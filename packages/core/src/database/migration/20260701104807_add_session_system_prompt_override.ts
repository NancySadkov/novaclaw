import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260701104807_add_session_system_prompt_override",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`system_prompt_override\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
