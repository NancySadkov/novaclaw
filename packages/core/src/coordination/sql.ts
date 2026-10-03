import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * The coordination task each officer declared for itself, or its superior assigned — one row per
 * agent.
 *
 * ⚠️ A component on the AGENT, not on its chat. A chat is itself a component (`ses_<agent>`), and a
 * task hung off a transcript would die with a "Clear chat" — which is exactly the moment the officer
 * most needs to be told what it is working on. Keyed by agent id so it outlives every chat.
 *
 * ⚠️ ABSENT, not empty, when there is no task: `none set yet` is rendered at READ time, and clearing
 * DELETES the row so "no task" and "a task that says nothing" cannot be confused.
 */
export const AgentCoordinationTable = sqliteTable("agent_coordination", {
  agent: text().primaryKey(),
  /** One short line: what this officer is working on, in its own terms. */
  task: text().notNull(),
  ...Timestamps,
})
