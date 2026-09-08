import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export type FireOutcome = "pending" | "succeeded" | "failed" | "interrupted"

// Calendar / cron-session creator. A HOT operational store — schedules +
// their fire ledger — NOT the durable KB (two-DB discipline). `recurrence_json` holds a structured
// `Recurrence` (schedule/recurrence.ts), never a cron string. `next_fire_at` is denormalised for a cheap
// ticker scan; `calendar_fire` is the idempotency + history ledger (unique per occurrence).
export const CalendarScheduleTable = sqliteTable(
  "calendar_schedule",
  {
    id: text().primaryKey(),
    title: text().notNull().default(""),
    recurrence_json: text().notNull(),
    tz_offset_min: integer().notNull().default(0),
    prompt: text().notNull(),
    agent: text(),
    model: text(),
    location_json: text(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    next_fire_at: integer(),
    last_fired_at: integer(),
    ...Timestamps,
    permission_mode: text(),
  },
  (table) => [index("calendar_schedule_due_idx").on(table.enabled, table.next_fire_at)],
)

export const CalendarFireTable = sqliteTable(
  "calendar_fire",
  {
    id: text().primaryKey(),
    schedule_id: text()
      .notNull()
      .references(() => CalendarScheduleTable.id, { onDelete: "cascade" }),
    occurrence_millis: integer().notNull(),
    fired_at: integer().notNull(),
    session_id: text(),
    status: text().$type<"spawned" | "skipped" | "error">().notNull(),
    outcome: text().$type<FireOutcome>().notNull().default("pending"),
  },
  (table) => [
    uniqueIndex("calendar_fire_occurrence_idx").on(table.schedule_id, table.occurrence_millis),
    index("calendar_fire_fired_at_idx").on(table.fired_at),
  ],
)
