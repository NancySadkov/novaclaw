import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808131913_add_session_component_registry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_component\` (
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`component_id\` text NOT NULL,
          \`schema_version\` integer NOT NULL,
          \`lifetime\` text NOT NULL,
          \`attempt_id\` text,
          \`generation\` integer,
          \`expires_at\` integer,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_component_pk\` PRIMARY KEY(\`session_id\`, \`kind\`, \`component_id\`),
          CONSTRAINT \`fk_session_component_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_component_kind_idx\` ON \`session_component\` (\`kind\`);`)
      yield* tx.run(`CREATE INDEX \`session_component_expiry_idx\` ON \`session_component\` (\`expires_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
