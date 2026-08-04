import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// T2 (notes/entities.md): saved permissions re-key from the project entity onto the derived
// `origin` hash. Values are IDENTICAL (origin := the old project id string), so this is a
// straight column rename — but SQLite can't drop the project FK in place, so the table rebuilds.
export default {
  id: "20260717120000_permission_origin",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_new\` (
          \`id\` text PRIMARY KEY,
          \`origin\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`effect\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        INSERT INTO \`permission_new\`
        SELECT \`id\`, \`project_id\`, \`action\`, \`resource\`, \`effect\`, \`time_created\`, \`time_updated\`
        FROM \`permission\`;
      `)
      yield* tx.run(`DROP TABLE \`permission\`;`)
      yield* tx.run(`ALTER TABLE \`permission_new\` RENAME TO \`permission\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_origin_action_resource_idx\` ON \`permission\` (\`origin\`,\`action\`,\`resource\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
