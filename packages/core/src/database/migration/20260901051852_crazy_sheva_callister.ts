import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260901051852_crazy_sheva_callister",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`permission_pending_origin_session_idx\`;`)
      yield* tx.run(`DROP TABLE \`permission_pending\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
