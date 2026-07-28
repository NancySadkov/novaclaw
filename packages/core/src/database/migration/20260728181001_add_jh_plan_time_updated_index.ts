import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260728181001_add_jh_plan_time_updated_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`jh_plan_time_updated_id_idx\` ON \`jh_plan\` (\`time_updated\`,\`id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
