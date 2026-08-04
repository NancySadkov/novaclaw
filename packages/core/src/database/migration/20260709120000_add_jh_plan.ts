import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// jh (Juvenile Harness) persistence — the plan/artifact/log tables (jh.md §6b). Engine-internal state;
// mirrors `jh/sql.ts` and the corresponding block in `schema.gen.ts` — keep the three in sync.
export default {
  id: "20260709120000_add_jh_plan",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`jh_artifact\` (
          \`plan_id\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`hash\` text NOT NULL,
          \`content\` text NOT NULL,
          CONSTRAINT \`jh_artifact_pk\` PRIMARY KEY(\`plan_id\`, \`artifact_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`jh_log\` (
          \`plan_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`entry\` text NOT NULL,
          CONSTRAINT \`jh_log_pk\` PRIMARY KEY(\`plan_id\`, \`seq\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`jh_plan\` (
          \`id\` text PRIMARY KEY,
          \`goal\` text NOT NULL,
          \`status\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
