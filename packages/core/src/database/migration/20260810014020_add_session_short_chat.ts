import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810014020_add_session_short_chat",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`short_chat\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
