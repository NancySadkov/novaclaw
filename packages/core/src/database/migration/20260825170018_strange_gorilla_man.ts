import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260825170018_strange_gorilla_man",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_access\` (
          \`id\` text PRIMARY KEY,
          \`recall_id\` text NOT NULL,
          \`fingerprint\` text NOT NULL,
          \`surface\` text NOT NULL,
          \`memory_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`rank\` integer NOT NULL,
          \`score\` real NOT NULL,
          \`accessed_at\` integer NOT NULL,
          \`used_at\` integer,
          \`useful_at\` integer,
          \`corrected_at\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_usage\` (
          \`memory_id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`conflict_key\` text,
          \`first_accessed_at\` integer NOT NULL,
          \`last_accessed_at\` integer NOT NULL,
          \`accesses\` integer DEFAULT 0 NOT NULL,
          \`uses\` integer DEFAULT 0 NOT NULL,
          \`useful\` integer DEFAULT 0 NOT NULL,
          \`corrections\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`memory_access_memory_idx\` ON \`memory_access\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_access_recall_idx\` ON \`memory_access\` (\`recall_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_access_at_idx\` ON \`memory_access\` (\`accessed_at\`);`)
      yield* tx.run(`CREATE INDEX \`memory_usage_scope_idx\` ON \`memory_usage\` (\`scope\`);`)
      yield* tx.run(`CREATE INDEX \`memory_usage_conflict_idx\` ON \`memory_usage\` (\`conflict_key\`);`)
      yield* tx.run(`CREATE INDEX \`memory_usage_last_idx\` ON \`memory_usage\` (\`last_accessed_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
