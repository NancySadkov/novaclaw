import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801085049_add_tool_catalogue",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`tool_catalogue\` (
          \`scope\` text NOT NULL,
          \`name\` text NOT NULL,
          \`server\` text NOT NULL,
          \`description\` text NOT NULL,
          \`argument_names\` text NOT NULL,
          \`arguments\` text NOT NULL,
          \`input_schema\` text NOT NULL,
          \`keywords\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tool_catalogue_pk\` PRIMARY KEY(\`scope\`, \`name\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`tool_catalogue_scope_server_idx\` ON \`tool_catalogue\` (\`scope\`,\`server\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
