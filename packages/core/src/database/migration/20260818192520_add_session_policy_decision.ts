import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260818192520_add_session_policy_decision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_policy_decision\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`detail\` text NOT NULL,
          \`providers\` text NOT NULL,
          \`patched\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_policy_decision_session_idx\` ON \`session_policy_decision\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_policy_decision_call_idx\` ON \`session_policy_decision\` (\`tool_call_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
