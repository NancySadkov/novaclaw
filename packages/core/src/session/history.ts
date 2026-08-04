export * as SessionHistory from "./history"

import { and, asc, desc, eq, gt, lte, ne, or } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "../database/database"
import { Hash } from "../util/hash"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionCompactionTable, SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]
type MessageRow = typeof SessionMessageTable.$inferSelect
type CompactionRow = typeof SessionCompactionTable.$inferSelect

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

const decodeMessageRow = (row: MessageRow) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

/** SHA-256 identity of the exact, ordered, full-fidelity transcript prefix an overlay replaces. */
export const canonicalPrefixHash = (
  rows: readonly Pick<MessageRow, "id" | "type" | "seq" | "time_created" | "time_updated" | "data">[],
) => Hash.sha256(JSON.stringify(rows.map(canonical)))

export const prefixHash = Effect.fn("SessionHistory.prefixHash")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  prefixSeq: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        lte(SessionMessageTable.seq, prefixSeq),
        ne(SessionMessageTable.type, "compaction"),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return canonicalPrefixHash(rows)
})

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select()
    .from(SessionCompactionTable)
    .where(eq(SessionCompactionTable.session_id, sessionID))
    .orderBy(desc(SessionCompactionTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  const actual = yield* prefixHash(db, sessionID, row.prefix_seq)
  if (actual === row.prefix_hash) return row
  yield* Effect.logWarning("stale session compaction rejected", {
    sessionID,
    compactionID: row.id,
    prefixSeq: row.prefix_seq,
    expected: row.prefix_hash,
    actual,
  })
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: CompactionRow | undefined,
  baselineSeq?: number,
) {
  return yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gt(SessionMessageTable.seq, compaction.prefix_seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
})

const compactionEntry = (row: CompactionRow) => ({
  seq: row.prefix_seq,
  message: SessionMessage.Compaction.make({
    id: row.id,
    type: "compaction",
    reason: row.reason,
    summary: row.summary,
    recent: row.recent,
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    time: { created: DateTime.makeUnsafe(row.time_created) },
  }),
})

const projectedEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq?: number,
) {
  const compaction = yield* latestCompaction(db, sessionID)
  const entries = yield* Effect.forEach(yield* messageRows(db, sessionID, compaction, baselineSeq), (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
  if (!compaction) return entries
  const overlay = compactionEntry(compaction)
  const before = entries.filter((entry) => entry.seq <= compaction.prefix_seq)
  const after = entries.filter((entry) => entry.seq > compaction.prefix_seq)
  return [...before, overlay, ...after]
})

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const epoch = yield* db
    .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return (yield* projectedEntries(db, sessionID, epoch?.baselineSeq)).map((entry) => entry.message)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return yield* projectedEntries(db, sessionID, baselineSeq)
})
