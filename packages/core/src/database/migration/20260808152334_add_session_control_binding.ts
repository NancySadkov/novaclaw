import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808152334_add_session_control_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`control_binding\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
