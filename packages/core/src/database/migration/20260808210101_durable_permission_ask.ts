import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808210101_durable_permission_ask",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_pending\` (
          \`id\` text PRIMARY KEY,
          \`origin\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`request\` text NOT NULL,
          \`agent\` text,
          \`awaited\` integer NOT NULL,
          \`resolution\` text,
          \`feedback\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`permission_pending_origin_session_idx\` ON \`permission_pending\` (\`origin\`,\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
