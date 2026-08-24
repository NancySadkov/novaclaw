import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260824205121_amusing_invaders",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_agent_live_root_idx\` ON \`session\` (\`agent\`) WHERE "session"."parent_id" IS NULL AND "session"."time_archived" IS NULL AND "session"."agent" IS NOT NULL AND "session"."agent" NOT IN ('build', 'plan');`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
