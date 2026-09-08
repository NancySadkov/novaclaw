import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// The one-shot manual-compaction marker (`compaction-request.ts` holds the why it is durable).
export const SessionCompactionRequestTable = sqliteTable("session_compaction_request", {
  /** One pending request per session; re-requesting is idempotent. */
  session_id: text().primaryKey(),
  requested_at: integer().notNull(),
})
