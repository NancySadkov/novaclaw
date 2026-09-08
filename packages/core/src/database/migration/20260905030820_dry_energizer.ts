import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260905030820_dry_energizer",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`calendar_fire\` ADD \`outcome\` text DEFAULT 'pending' NOT NULL;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_calendar_fire\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`occurrence_millis\` integer NOT NULL,
          \`fired_at\` integer NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`outcome\` text DEFAULT 'pending' NOT NULL,
          CONSTRAINT \`fk_calendar_fire_schedule_id_calendar_schedule_id_fk\` FOREIGN KEY (\`schedule_id\`) REFERENCES \`calendar_schedule\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_calendar_fire\`(\`id\`, \`schedule_id\`, \`occurrence_millis\`, \`fired_at\`, \`session_id\`, \`status\`) SELECT \`id\`, \`schedule_id\`, \`occurrence_millis\`, \`fired_at\`, \`session_id\`, \`status\` FROM \`calendar_fire\`;`,
      )
      yield* tx.run(`DROP TABLE \`calendar_fire\`;`)
      yield* tx.run(`ALTER TABLE \`__new_calendar_fire\` RENAME TO \`calendar_fire\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`calendar_fire_occurrence_idx\` ON \`calendar_fire\` (\`schedule_id\`,\`occurrence_millis\`);`,
      )
      yield* tx.run(`CREATE INDEX \`calendar_fire_fired_at_idx\` ON \`calendar_fire\` (\`fired_at\`);`)
      yield* tx.run(`CREATE INDEX \`messenger_inbound_routed_idx\` ON \`messenger_inbound\` (\`time_routed\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
