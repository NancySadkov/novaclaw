import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814182155_add_community_contact",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_contact\` (
          \`network_id\` text PRIMARY KEY,
          \`petname\` text,
          \`routes\` text NOT NULL,
          \`last_seen_at\` integer,
          \`blocked\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
