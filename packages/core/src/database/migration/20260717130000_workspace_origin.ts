import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// T2 (notes/entities.md): workspaces re-key from the project entity onto the derived `origin`
// hash (identical values — a straight rename); the table rebuilds to drop the project FK.
export default {
  id: "20260717130000_workspace_origin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace_new\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`origin\` text NOT NULL,
          \`time_used\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        INSERT INTO \`workspace_new\`
        SELECT \`id\`, \`type\`, \`name\`, \`branch\`, \`directory\`, \`extra\`, \`project_id\`, \`time_used\`
        FROM \`workspace\`;
      `)
      yield* tx.run(`DROP TABLE \`workspace\`;`)
      yield* tx.run(`ALTER TABLE \`workspace_new\` RENAME TO \`workspace\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
