import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"

export const ScratchHorizonTable = sqliteTable("agent_scratch_horizon", {
  agent: text().primaryKey(),
  session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  completed_at: integer(),
  cycle_at: integer().notNull(),
  horizon_days: integer().notNull(),
  phase: text().$type<"scan" | "notify" | "idle">().notNull(),
})
