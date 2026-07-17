export * as SessionMessageRead from "./message-read"

import { Effect, Schema } from "effect"
import { and, asc, desc, eq, gt, lt } from "drizzle-orm"
import type { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

/**
 * Deps-taking native transcript reads (the `SessionRead` pattern): read a session's
 * `session_message` rows with a plain `db` handle, so callers outside the location-service
 * graph (the CLI — F1c-0) don't need the `SessionV2` layer. `SessionV2.messages` delegates
 * here. Callers own the session-existence check: an unknown session reads as an empty
 * transcript.
 */

export interface ListInput {
  readonly sessionID: SessionSchema.ID
  readonly limit?: number
  readonly order?: "asc" | "desc"
  readonly cursor?: {
    readonly id: SessionMessage.ID
    readonly direction: "previous" | "next"
  }
}

const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

export const decodeRow = (
  row: typeof SessionMessageTable.$inferSelect,
): Effect.Effect<SessionMessage.Message, MessageDecodeError> =>
  decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const list = (
  db: Database.Interface["db"],
  input: ListInput,
): Effect.Effect<SessionMessage.Message[], MessageDecodeError> =>
  Effect.gen(function* () {
    const direction = input.cursor?.direction ?? "next"
    const requestedOrder = input.order ?? "desc"
    const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
    const anchor = input.cursor
      ? yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)))
          .get()
          .pipe(Effect.orDie)
      : undefined
    if (input.cursor && !anchor) return []
    const boundary = anchor
      ? order === "asc"
        ? gt(SessionMessageTable.seq, anchor.seq)
        : lt(SessionMessageTable.seq, anchor.seq)
      : undefined
    const where = boundary
      ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
      : eq(SessionMessageTable.session_id, input.sessionID)
    const query = db
      .select()
      .from(SessionMessageTable)
      .where(where)
      .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
    const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
    return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decodeRow)
  })
