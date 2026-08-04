import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Tags component on the session entity (notes/entities.md T0): a sparse (session_id, tag) store —
// the ECS tag component that replaces project-grouping as the organization system over chats.
// Mirrors `session/sql.ts` SessionTagTable — keep the two in sync.
export default {
  id: "20260706220000_add_session_tag",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_tag\` (
          \`session_id\` text NOT NULL,
          \`tag\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_tag_pk\` PRIMARY KEY(\`session_id\`, \`tag\`),
          CONSTRAINT \`fk_session_tag_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_tag_tag_idx\` ON \`session_tag\` (\`tag\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
