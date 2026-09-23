import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923190000_agent_schedule",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE \`agent_schedule\` (
        \`id\` text PRIMARY KEY,
        \`agent\` text NOT NULL,
        \`title\` text DEFAULT '' NOT NULL,
        \`recurrence_json\` text NOT NULL,
        \`tz_offset_min\` integer DEFAULT 0 NOT NULL,
        \`prompt\` text NOT NULL,
        \`duration_minutes\` integer DEFAULT 60 NOT NULL,
        \`heartbeat_minutes\` integer DEFAULT 10 NOT NULL,
        \`escalate_on_failure\` integer DEFAULT true NOT NULL,
        \`enabled\` integer DEFAULT true NOT NULL,
        \`next_fire_at\` integer,
        \`last_fired_at\` integer,
        \`time_created\` integer NOT NULL,
        \`time_updated\` integer NOT NULL
      );`)
      yield* tx.run(`INSERT INTO \`agent_schedule\` (
        \`id\`, \`agent\`, \`title\`, \`recurrence_json\`, \`tz_offset_min\`, \`prompt\`,
        \`enabled\`, \`next_fire_at\`, \`last_fired_at\`, \`time_created\`, \`time_updated\`
      ) SELECT \`id\`, \`agent\`, \`title\`, \`recurrence_json\`, \`tz_offset_min\`, \`prompt\`,
        \`enabled\`, \`next_fire_at\`, \`last_fired_at\`, \`time_created\`, \`time_updated\`
      FROM \`calendar_schedule\`;`)
      yield* tx.run(`CREATE TABLE \`agent_schedule_window\` (
        \`id\` text PRIMARY KEY,
        \`schedule_id\` text NOT NULL,
        \`occurrence_millis\` integer NOT NULL,
        \`window_end_at\` integer NOT NULL,
        \`next_heartbeat_at\` integer,
        \`last_heartbeat_at\` integer,
        \`confirmed_at\` integer,
        \`failed_at\` integer,
        \`escalated_at\` integer,
        \`outcome\` text DEFAULT 'active' NOT NULL,
        CONSTRAINT \`fk_agent_schedule_window_schedule_id_agent_schedule_id_fk\` FOREIGN KEY (\`schedule_id\`) REFERENCES \`agent_schedule\`(\`id\`) ON DELETE CASCADE
      );`)
      yield* tx.run(`DROP TABLE \`calendar_fire\`;`)
      yield* tx.run(`DROP TABLE \`calendar_schedule\`;`)
      yield* tx.run(`CREATE INDEX \`agent_schedule_due_idx\` ON \`agent_schedule\` (\`enabled\`,\`next_fire_at\`);`)
      yield* tx.run(`CREATE INDEX \`agent_schedule_agent_idx\` ON \`agent_schedule\` (\`agent\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`agent_schedule_window_occurrence_idx\` ON \`agent_schedule_window\` (\`schedule_id\`,\`occurrence_millis\`);`)
      yield* tx.run(`CREATE INDEX \`agent_schedule_window_heartbeat_idx\` ON \`agent_schedule_window\` (\`outcome\`,\`next_heartbeat_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
