import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815072143_add_direct_message",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_direct_message\` (
          \`id\` text PRIMARY KEY,
          \`peer\` text NOT NULL,
          \`direction\` text NOT NULL,
          \`body\` text NOT NULL,
          \`claimed_at\` integer NOT NULL,
          \`received_at\` integer NOT NULL,
          \`signature\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`community_direct_message_peer_idx\` ON \`community_direct_message\` (\`peer\`,\`received_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
