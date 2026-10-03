import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261003035715_windy_proudstar",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_stuck_counter\` (
          \`agent\` text PRIMARY KEY,
          \`count\` integer NOT NULL,
          \`window_start\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
