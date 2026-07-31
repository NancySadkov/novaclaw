import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731023939_add_messenger_initiation_budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`messenger_initiation\` (
          \`scope\` text PRIMARY KEY,
          \`day\` text NOT NULL,
          \`count\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
