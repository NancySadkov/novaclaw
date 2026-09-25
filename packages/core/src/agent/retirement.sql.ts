import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const AgentRetirementTable = sqliteTable(
  "agent_retirement",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    agent: text().notNull(),
    retired_at: integer().notNull(),
  },
  (table) => [index("agent_retirement_agent_at_idx").on(table.agent, table.retired_at)],
)
