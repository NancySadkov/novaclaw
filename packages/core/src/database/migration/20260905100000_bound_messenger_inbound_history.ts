import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260905100000_bound_messenger_inbound_history",
  up(tx) {
    return Effect.gen(function* () {
      // Routed ids are retained for replay safety, but cleanup only needs to find old rows. The
      // primary key serves the per-chat survivor lookup; this index makes the age scan independent
      // of total inbound volume on upgraded databases too.
      yield* tx.run(`CREATE INDEX \`messenger_inbound_routed_idx\` ON \`messenger_inbound\` (\`time_routed\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
