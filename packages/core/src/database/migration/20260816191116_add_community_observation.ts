import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816191116_add_community_observation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_observation\` (
          \`id\` text PRIMARY KEY,
          \`subject\` text NOT NULL,
          \`observed_at\` integer NOT NULL,
          \`context\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`note\` text,
          \`about\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`community_observation_subject_idx\` ON \`community_observation\` (\`subject\`,\`observed_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
