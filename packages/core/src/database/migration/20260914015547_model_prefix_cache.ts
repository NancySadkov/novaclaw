import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260914015547_model_prefix_cache",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`model_prefix_cache\` (
          \`id\` text PRIMARY KEY,
          \`model\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`bytes\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`model_prefix_cache_model_expires_idx\` ON \`model_prefix_cache\` (\`model\`,\`expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
