import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Last claimed occurrence per session+nudge. Tool/compaction ids dedupe replay; resource and clock
 * occurrences are deliberately bucketed by the matcher so a persistent warning stays quiet. */
export const NudgeDeliveryTable = sqliteTable(
  "session_nudge_delivery",
  {
    session_id: text().notNull(),
    nudge_id: text().notNull(),
    occurrence: text().notNull(),
    fired_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.nudge_id] })],
)
