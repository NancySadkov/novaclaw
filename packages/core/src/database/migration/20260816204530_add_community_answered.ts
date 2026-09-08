import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816204530_add_community_answered",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_answered\` (
          \`id\` text PRIMARY KEY,
          \`asker\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`community_answered_at_idx\` ON \`community_answered\` (\`at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
