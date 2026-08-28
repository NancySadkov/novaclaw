import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828125640_lumpy_paladin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_status\` (
          \`agent\` text PRIMARY KEY,
          \`task\` text NOT NULL,
          \`observed\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
