import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813001757_add_todo_snapshot",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`todo_snapshot\` (
          \`attempt_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_snapshot_pk\` PRIMARY KEY(\`attempt_id\`, \`position\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`todo_snapshot_attempt_idx\` ON \`todo_snapshot\` (\`attempt_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
