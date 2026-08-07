import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260807173556_add_session_device",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`device\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
