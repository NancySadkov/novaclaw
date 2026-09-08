import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260702210000_add_session_type_priority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`type\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`priority\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
