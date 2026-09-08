import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260702230000_add_permission_mode_and_saved_effect",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`permission_mode\` text;`)
      yield* tx.run(`ALTER TABLE \`permission\` ADD \`effect\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
