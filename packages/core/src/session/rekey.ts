import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import type { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

type Db = Database.Interface["db"]

// These are every current table whose rows belong to a session but whose foreign key is not an
// UPDATE CASCADE. The list is deliberately owned at this seam: changing a session's identity must
// not depend on each caller remembering another component table.
const SESSION_REFERENCE_TABLES = [
  "session_auto_grant",
  "session_component",
  "todo",
  "session_tag",
  "session_message",
  "session_compaction",
  "session_input",
  "session_context_epoch",
  "session_compaction_request",
  "session_memory_cleanup",
  "session_quality_check",
  "session_policy_decision",
  "session_execution",
  "messenger_binding",
  "calendar_fire",
] as const

/**
 * Rewrite only fields whose schema makes them session references. Event payloads also carry
 * arbitrary user text and tool arguments; a SQL `replace()` over the JSON blob would silently
 * edit that content whenever it happened to mention the old id.
 */
const rekeyEventData = (type: string, value: unknown, oldID: string, newID: string): unknown => {
  if (value === null || typeof value !== "object") return value
  const result = { ...(value as Record<string, unknown>) }
  if (result.sessionID === oldID) result.sessionID = newID
  if (result.parentID === oldID) result.parentID = newID
  // Only record lifecycle events carry a Session.Info here. Prompt, tool and metadata objects
  // are user content even when one of their nested fields happens to be called sessionID or info.
  if (/^session\.(created|updated|deleted)\.\d+$/.test(type) && result.info && typeof result.info === "object") {
    const info = { ...(result.info as Record<string, unknown>) }
    if (info.id === oldID) info.id = newID
    if (info.parentID === oldID) info.parentID = newID
    result.info = info
  }
  return result
}

/**
 * Give an archived chat a history-only id before its agent's canonical live id is reused.
 *
 * The operation is intentionally storage-level and atomic. An archived session cannot be copied
 * through the event projector: the projector would publish a second live identity, and a partial
 * copy would strand one of the session's components. Foreign-key checks are deferred to transaction
 * commit while the existing identity and its references are renamed; no new session is created.
 * Event payloads are rewritten as well; replaying the history must not resurrect the old
 * canonical id in derived state.
 */
export const moveArchivedToHistory = (
  db: Db,
  oldID: SessionSchema.ID,
  historyID: SessionSchema.ID,
): Effect.Effect<boolean> =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        const old = yield* tx
          .select()
          .from(SessionTable)
          .where(sql`${SessionTable.id} = ${oldID}`)
          .get()
          .pipe(Effect.orDie)
        if (!old || old.time_archived === null) return false

        yield* tx.run(sql`PRAGMA defer_foreign_keys = ON`).pipe(Effect.orDie)
        yield* tx
          .update(SessionTable)
          .set({ id: historyID })
          .where(sql`${SessionTable.id} = ${oldID}`)
          .run()
          .pipe(Effect.orDie)

        for (const table of SESSION_REFERENCE_TABLES)
          yield* tx
            .run(sql`UPDATE ${sql.identifier(table)} SET "session_id" = ${historyID} WHERE "session_id" = ${oldID}`)
            .pipe(Effect.orDie)

        // Children point at the old root through parent_id rather than session_id.
        yield* tx
          .run(sql`UPDATE "session" SET "parent_id" = ${historyID} WHERE "parent_id" = ${oldID}`)
          .pipe(Effect.orDie)

        // Event rows have their own aggregate foreign key, so create the replacement sequence before
        // moving them. The payload replacement keeps persisted SessionEvent data coherent too.
        const sequence = yield* tx
          .get<{
            seq: number
            owner_id: string | null
          }>(sql`SELECT "seq", "owner_id" FROM "event_sequence" WHERE "aggregate_id" = ${oldID}`)
          .pipe(Effect.orDie)
        if (sequence) {
          yield* tx
            .run(
              sql`INSERT INTO "event_sequence" ("aggregate_id", "seq", "owner_id") VALUES (${historyID}, ${sequence.seq}, ${sequence.owner_id})`,
            )
            .pipe(Effect.orDie)
          const events = yield* tx
            .select()
            .from(EventTable)
            .where(sql`${EventTable.aggregate_id} = ${oldID}`)
            .all()
            .pipe(Effect.orDie)
          for (const event of events) {
            yield* tx
              .update(EventTable)
              .set({
                aggregate_id: historyID,
                data: rekeyEventData(event.type, event.data, String(oldID), String(historyID)) as Record<
                  string,
                  unknown
                >,
              })
              .where(sql`${EventTable.id} = ${event.id}`)
              .run()
              .pipe(Effect.orDie)
          }
          yield* tx.run(sql`DELETE FROM "event_sequence" WHERE "aggregate_id" = ${oldID}`).pipe(Effect.orDie)
        }

        return true
      }),
    )
    .pipe(Effect.orDie)
