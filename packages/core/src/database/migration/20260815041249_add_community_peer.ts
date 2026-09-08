import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815041249_add_community_peer",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_peer\` (
          \`network_id\` text PRIMARY KEY,
          \`routes\` text NOT NULL,
          \`last_seen_at\` integer,
          \`source\` text DEFAULT 'px' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
