import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// KB-A: the knowledge-base PoC store (facts with provenance + bitemporal audit
// columns). Mirrors the kb_fact block in schema.gen.ts — keep the two in sync.
export default {
  id: "20260703120000_add_kb_fact",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`kb_fact\` (
          \`id\` text PRIMARY KEY,
          \`subject\` text NOT NULL,
          \`predicate\` text NOT NULL,
          \`object\` text NOT NULL,
          \`relation\` text NOT NULL,
          \`source\` text,
          \`agent\` text,
          \`confidence\` real,
          \`valid_from\` integer NOT NULL,
          \`valid_to\` integer,
          \`superseded_by\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`kb_fact_subject_idx\` ON \`kb_fact\` (\`subject\`,\`valid_to\`);`)
      yield* tx.run(`CREATE INDEX \`kb_fact_predicate_idx\` ON \`kb_fact\` (\`predicate\`,\`valid_to\`);`)
      yield* tx.run(`CREATE INDEX \`kb_fact_object_idx\` ON \`kb_fact\` (\`object\`,\`valid_to\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
