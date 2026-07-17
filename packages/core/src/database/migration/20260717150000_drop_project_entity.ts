import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// T3 (notes/entities.md): the project ENTITY dies. Sessions keep only their substrate
// attributes (directory, path); the session table rebuilds to shed `project_id` + its FK, then
// the `project` and `project_directory` tables drop. Saved permissions and workspaces already
// re-keyed onto `origin` (T2 S2/S3), so nothing else references the entity.
export default {
  id: "20260717150000_drop_project_entity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_new\` (
          \`id\` text PRIMARY KEY,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`system_prompt_override\` text,
          \`type\` text,
          \`priority\` integer,
          \`responder\` text,
          \`permission_mode\` text,
          \`strict\` text,
          \`introspection\` integer,
          \`quality\` integer,
          \`affective\` integer,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer
        );
      `)
      yield* tx.run(`
        INSERT INTO \`session_new\`
        SELECT \`id\`, \`workspace_id\`, \`parent_id\`, \`slug\`, \`directory\`, \`path\`, \`title\`,
          \`version\`, \`share_url\`, \`summary_additions\`, \`summary_deletions\`, \`summary_files\`,
          \`summary_diffs\`, \`metadata\`, \`cost\`, \`tokens_input\`, \`tokens_output\`,
          \`tokens_reasoning\`, \`tokens_cache_read\`, \`tokens_cache_write\`, \`revert\`,
          \`permission\`, \`agent\`, \`model\`, \`system_prompt_override\`, \`type\`, \`priority\`,
          \`responder\`, \`permission_mode\`, \`strict\`, \`introspection\`, \`quality\`,
          \`affective\`, \`result\`, \`time_created\`, \`time_updated\`, \`time_compacting\`,
          \`time_archived\`
        FROM \`session\`;
      `)
      yield* tx.run(`DROP TABLE \`session\`;`)
      yield* tx.run(`ALTER TABLE \`session_new\` RENAME TO \`session\`;`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`DROP TABLE IF EXISTS \`project_directory\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`project\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
