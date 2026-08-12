import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812165955_add_session_quality_check",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_quality_check\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`command\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`exit_code\` integer,
          \`timed_out\` integer DEFAULT false NOT NULL,
          \`duration_ms\` integer,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_quality_check_session_idx\` ON \`session_quality_check\` (\`session_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
