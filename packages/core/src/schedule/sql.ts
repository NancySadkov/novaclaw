import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export type WindowOutcome = "active" | "confirmed" | "failed"

export const AgentScheduleTable = sqliteTable(
  "agent_schedule",
  {
    id: text().primaryKey(),
    agent: text().notNull(),
    title: text().notNull().default(""),
    recurrence_json: text().notNull(),
    tz_offset_min: integer().notNull().default(0),
    prompt: text().notNull(),
    duration_minutes: integer().notNull().default(60),
    heartbeat_minutes: integer().notNull().default(10),
    escalate_on_failure: integer({ mode: "boolean" }).notNull().default(true),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    next_fire_at: integer(),
    last_fired_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("agent_schedule_due_idx").on(table.enabled, table.next_fire_at),
    index("agent_schedule_agent_idx").on(table.agent),
  ],
)

export const AgentScheduleWindowTable = sqliteTable(
  "agent_schedule_window",
  {
    id: text().primaryKey(),
    schedule_id: text().notNull().references(() => AgentScheduleTable.id, { onDelete: "cascade" }),
    occurrence_millis: integer().notNull(),
    window_end_at: integer().notNull(),
    next_heartbeat_at: integer(),
    last_heartbeat_at: integer(),
    confirmed_at: integer(),
    failed_at: integer(),
    escalated_at: integer(),
    outcome: text().$type<WindowOutcome>().notNull().default("active"),
  },
  (table) => [
    uniqueIndex("agent_schedule_window_occurrence_idx").on(table.schedule_id, table.occurrence_millis),
    index("agent_schedule_window_heartbeat_idx").on(table.outcome, table.next_heartbeat_at),
  ],
)
