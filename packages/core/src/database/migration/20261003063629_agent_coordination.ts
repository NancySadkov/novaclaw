import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003063629_agent_coordination",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_coordination\` (
          \`agent\` text PRIMARY KEY,
          \`task\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
