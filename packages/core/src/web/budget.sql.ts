import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core"

// The web traffic governor's durable half (core/web/fetch-pace.ts is the pure policy).
//
// Why this is a TABLE and not just a map: the whole point of a per-host daily cap is to survive the
// failure it guards against. A runaway agent that crash-loops would reset an in-memory counter on every
// restart and hammer a host all day — the counter has to outlive the process. `tokens` is fractional
// (a partially-refilled bucket), so it is REAL, not INTEGER.
export const WebHostBudgetTable = sqliteTable("web_host_budget", {
  host: text().primaryKey(),
  /** UTC day (YYYY-MM-DD) the count belongs to; a different day resets it. */
  day: text().notNull(),
  count: integer().notNull().default(0),
  tokens: real().notNull().default(0),
  /** May sit in the FUTURE — each decision claims its slot forward so the next read queues behind it. */
  updated_at: integer().notNull(),
})
