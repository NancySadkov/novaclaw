import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260904004405_drop_inert_session_permission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` DROP COLUMN \`permission\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
