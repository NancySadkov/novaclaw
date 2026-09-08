import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260714141710_add_command_config",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`command_config\` (
          \`name\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
