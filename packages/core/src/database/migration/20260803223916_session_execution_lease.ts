import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803223916_session_execution_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_execution\` (
          \`session_id\` text PRIMARY KEY,
          \`attempt_id\` text NOT NULL UNIQUE,
          \`generation\` integer NOT NULL,
          \`owner_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`failure_class\` text,
          \`failure_detail\` text,
          \`failure_count\` integer DEFAULT 0 NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`checkpoint_at\` integer,
          \`started_at\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_execution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_execution_state_heartbeat_idx\` ON \`session_execution\` (\`state\`,\`heartbeat_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
