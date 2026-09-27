import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260927225632_work_projects",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`project_notice\` (
          \`agent\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`text\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_officer\` (
          \`agent\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          CONSTRAINT \`fk_project_officer_project_id_work_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`work_project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_project\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`objective\` text NOT NULL,
          \`phases\` text NOT NULL,
          \`paused\` integer DEFAULT false NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`project_officer_project_idx\` ON \`project_officer\` (\`project_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
