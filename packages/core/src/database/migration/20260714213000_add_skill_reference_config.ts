import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260714213000_add_skill_reference_config",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`skill_config\` (
          \`source\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reference_config\` (
          \`name\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
