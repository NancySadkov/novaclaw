import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260730221834_add_session_safe_mode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`safe_mode\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
