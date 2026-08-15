import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815054456_add_community_succession",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_succession\` (
          \`network_id\` text PRIMARY KEY,
          \`successor_id\` text NOT NULL,
          \`claimed_at\` integer NOT NULL,
          \`signature\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
