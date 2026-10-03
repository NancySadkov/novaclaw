import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const AgentStuckCounterTable = sqliteTable("agent_stuck_counter", {
  agent: text().primaryKey(),
  count: integer().notNull(),
  window_start: integer().notNull(),
})
