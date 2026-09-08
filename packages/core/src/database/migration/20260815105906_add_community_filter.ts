import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260815105906_add_community_filter",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_filter\` (
          \`pattern\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
