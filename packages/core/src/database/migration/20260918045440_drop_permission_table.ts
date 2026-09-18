import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918045440_drop_permission_table",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`permission_origin_action_resource_idx\`;`)
      yield* tx.run(`DROP TABLE \`permission\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
