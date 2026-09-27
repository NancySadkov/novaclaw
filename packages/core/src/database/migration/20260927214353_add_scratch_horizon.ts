import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260927214353_add_scratch_horizon",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_scratch_horizon\` (
          \`agent\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`completed_at\` integer,
          \`cycle_at\` integer NOT NULL,
          \`horizon_days\` integer NOT NULL,
          \`phase\` text NOT NULL,
          CONSTRAINT \`fk_agent_scratch_horizon_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
