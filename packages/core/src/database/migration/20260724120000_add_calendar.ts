import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Calendar / cron-session creator (P1): the schedule store + its fire ledger. Mirrors
// schedule/calendar.sql.ts and the calendar block in schema.gen.ts — keep the three in sync.
export default {
  id: "20260724120000_add_calendar",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`calendar_schedule\` (
          \`id\` text PRIMARY KEY,
          \`title\` text DEFAULT '' NOT NULL,
          \`recurrence_json\` text NOT NULL,
          \`tz_offset_min\` integer DEFAULT 0 NOT NULL,
          \`prompt\` text NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`location_json\` text,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`next_fire_at\` integer,
          \`last_fired_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`calendar_fire\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`occurrence_millis\` integer NOT NULL,
          \`fired_at\` integer NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`calendar_schedule_due_idx\` ON \`calendar_schedule\` (\`enabled\`,\`next_fire_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`calendar_fire_occurrence_idx\` ON \`calendar_fire\` (\`schedule_id\`,\`occurrence_millis\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
