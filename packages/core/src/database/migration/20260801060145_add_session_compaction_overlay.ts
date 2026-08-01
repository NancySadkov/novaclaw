import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801060145_add_session_compaction_overlay",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_compaction\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`prefix_seq\` integer NOT NULL,
          \`prefix_hash\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`recent\` text NOT NULL,
          \`metadata\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_compaction_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_compaction_session_seq_idx\` ON \`session_compaction\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_compaction_session_prefix_idx\` ON \`session_compaction\` (\`session_id\`,\`prefix_seq\`);`,
      )
      // Legacy summaries were stored as transcript messages and carried no verifiable prefix.
      // Invalidate those recomputable projections while preserving every source message.
      yield* tx.run(`DELETE FROM \`session_message\` WHERE \`type\` = 'compaction';`)
    })
  },
} satisfies DatabaseMigration.Migration
