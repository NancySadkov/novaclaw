import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "./schema"

/**
 * A TOMBSTONE: this chat is gone, and its memories have not caught up yet.
 *
 * See `memory-cleanup.ts` for why deletion cannot simply call the graph store inline. One row per
 * deleted session, so requesting twice is idempotent; the row lives until the memories are actually
 * gone, which is what makes an unavailable graph a DELAY rather than a silent forgetting.
 */
export const SessionMemoryCleanupTable = sqliteTable("session_memory_cleanup", {
  /**
   * The deleted session. Its memories live under `session:<id>`.
   *
   * ⚠️ Typed as the BRANDED id, matching `SessionTable.id`. A plain `string` here compiles until the
   * sweeper tries to compare the two, and the obvious escape at that point is a cast — which would
   * make it possible to write a tombstone for something that is not a session id at all.
   */
  session_id: text().$type<SessionSchema.ID>().primaryKey(),
  requested_at: integer().notNull(),
})
