import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260905090000_bound_calendar_fire_history",
  up(tx) {
    return Effect.gen(function* () {
      // The original calendar migration created a bare text schedule_id. Rebuild the small table so
      // existing installs gain the same cascading relationship as a fresh install. Orphans are
      // already unanswerable history, so discard them while the old table is still in place.
      yield* tx.run(`
        DELETE FROM \`calendar_fire\`
        WHERE \`schedule_id\` NOT IN (SELECT \`id\` FROM \`calendar_schedule\`);
      `)
      yield* tx.run(`
        CREATE TABLE \`__calendar_fire_new\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`occurrence_millis\` integer NOT NULL,
          \`fired_at\` integer NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          CONSTRAINT \`calendar_fire_schedule_fk\` FOREIGN KEY (\`schedule_id\`) REFERENCES \`calendar_schedule\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`__calendar_fire_new\` (\`id\`, \`schedule_id\`, \`occurrence_millis\`, \`fired_at\`, \`session_id\`, \`status\`)
        SELECT \`id\`, \`schedule_id\`, \`occurrence_millis\`, \`fired_at\`, \`session_id\`, \`status\`
        FROM \`calendar_fire\`;
      `)
      yield* tx.run(`DROP TABLE \`calendar_fire\`;`)
      yield* tx.run(`ALTER TABLE \`__calendar_fire_new\` RENAME TO \`calendar_fire\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`calendar_fire_occurrence_idx\` ON \`calendar_fire\` (\`schedule_id\`,\`occurrence_millis\`);`,
      )
      yield* tx.run(`CREATE INDEX \`calendar_fire_fired_at_idx\` ON \`calendar_fire\` (\`fired_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
