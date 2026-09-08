import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815084652_add_community_offer",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_offer\` (
          \`id\` text PRIMARY KEY,
          \`document\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
