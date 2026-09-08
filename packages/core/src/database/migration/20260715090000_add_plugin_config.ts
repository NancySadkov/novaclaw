import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260715090000_add_plugin_config",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`plugin_config\` (
          \`package\` text PRIMARY KEY,
          \`options\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
