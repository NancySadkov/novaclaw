import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923161501_late_wendell_vaughn",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_calendar_schedule\` (
          \`id\` text PRIMARY KEY,
          \`title\` text DEFAULT '' NOT NULL,
          \`recurrence_json\` text NOT NULL,
          \`tz_offset_min\` integer DEFAULT 0 NOT NULL,
          \`prompt\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`next_fire_at\` integer,
          \`last_fired_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_calendar_schedule\`(\`id\`, \`title\`, \`recurrence_json\`, \`tz_offset_min\`, \`prompt\`, \`agent\`, \`enabled\`, \`next_fire_at\`, \`last_fired_at\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`title\`, \`recurrence_json\`, \`tz_offset_min\`, \`prompt\`, COALESCE(NULLIF(\`agent\`, ''), 'nova'), \`enabled\`, \`next_fire_at\`, \`last_fired_at\`, \`time_created\`, \`time_updated\` FROM \`calendar_schedule\`;`,
      )
      yield* tx.run(`DROP TABLE \`calendar_schedule\`;`)
      yield* tx.run(`ALTER TABLE \`__new_calendar_schedule\` RENAME TO \`calendar_schedule\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE INDEX \`calendar_schedule_due_idx\` ON \`calendar_schedule\` (\`enabled\`,\`next_fire_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`calendar_schedule_agent_idx\` ON \`calendar_schedule\` (\`agent\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
