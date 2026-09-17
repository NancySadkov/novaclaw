export * as SessionContextEpoch from "./context-epoch"

import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SystemContext } from "../system-context/index"
import { ContextSnapshotDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable } from "./sql"

type DatabaseService = Database.Interface["db"]

interface Prepared {
  readonly baseline: string
  readonly baselineSeq: number
  /** The already-validated overlay, so the runner does not re-read and re-hash it immediately. */
  readonly compaction: SessionHistory.Compaction | null
}

export function initialize(
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
): Effect.Effect<Prepared | undefined, SystemContext.InitializationBlocked> {
  return initializeOnce(db, context, sessionID).pipe(Effect.withSpan("SessionContextEpoch.initialize"))
}

/**
 * A source whose PRESENCE is the runner's deliberate choice, and the presence it chose this turn.
 *
 * 🔴 Without this, a runner setting that stops supplying a source could only ever be reconciled — the
 * baseline was established once and a vanished source became a tail notice ("no longer apply") while
 * the system prompt kept the bytes. That is what happened to the AGENTS.md opt-in: turning it off still
 * delivered `Instructions from: …AGENTS.md` in every request, because the notice cannot edit a baseline
 * (owner report, 2026-09-17). A source listed here forces a REPLACE when its presence disagrees with the
 * snapshot, so the baseline is rebuilt to match the choice.
 *
 * ⚠️ Deliberately scoped to named keys. A source that vanishes because the WORLD changed (a file
 * deleted, a capability lost, a producer unavailable) must stay on the reconcile path — that is the
 * established "the prefix is stable; changes arrive as notices" design, and `SystemContext.reconcile`
 * has its own tests. Only the runner's own supply decision belongs here.
 */
export interface SourcePresence {
  readonly key: SystemContext.Key
  readonly present: boolean
}

export function prepare(
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  commitUpdate?: (input: {
    readonly data: typeof SessionEvent.ContextUpdated.data.Type
    readonly snapshot: SystemContext.Snapshot
  }) => Effect.Effect<void>,
  expectPresence?: ReadonlyArray<SourcePresence>,
  /**
   * Regenerate the baseline NOW, even though no compaction ran.
   *
   * 🔴 Owner, 2026-09-17: *"invalidate and regenerate the data when any of the prompt components
   * change."* The one prompt is the baseline, so a changed input (job instructions, roster, memos,
   * project, goal) must rebuild it rather than wait for the next compaction — otherwise the session
   * keeps SENDING stale text and every inspector keeps SHOWING it. It is set only when the rendered
   * prompt actually differs, so a casual turn (no component change) still reuses the bytes and keeps
   * the server's prefix cache.
   */
  forceReplace = false,
): Effect.Effect<Prepared, SystemContext.InitializationBlocked | ContextSnapshotDecodeError> {
  return prepareOnce(db, events, context, sessionID, commitUpdate, expectPresence, forceReplace).pipe(
    Effect.withSpan("SessionContextEpoch.prepare"),
  )
}

const prepareOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  commitUpdate?: (input: {
    readonly data: typeof SessionEvent.ContextUpdated.data.Type
    readonly snapshot: SystemContext.Snapshot
  }) => Effect.Effect<void>,
  expectPresence?: ReadonlyArray<SourcePresence>,
  forceReplace = false,
) {
  const [value, stored, compaction] = yield* Effect.all(
    [context, find(db, sessionID), SessionHistory.latestCompaction(db, sessionID)],
    { concurrency: "unbounded" },
  )
  if (!stored) {
    const generation = yield* SystemContext.initialize(value)
    const baselineSeq = yield* insert(db, sessionID, generation)
    return { baseline: generation.baseline, baselineSeq, compaction: null }
  }

  const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const replacementSeq = compaction !== undefined && compaction.seq > stored.baseline_seq ? compaction.seq : undefined
  // A runner-chosen source whose presence no longer matches the snapshot means the established baseline
  // does not describe the sources any more — a notice cannot edit a system prompt, so rebuild.
  const presenceChanged = (expectPresence ?? []).some(({ key, present }) => (snapshot[key] !== undefined) !== present)
  const result =
    replacementSeq || presenceChanged || forceReplace
      ? yield* SystemContext.replace(value, snapshot)
      : yield* SystemContext.reconcile(value, snapshot)
  if (result._tag === "Unchanged" || result._tag === "ReplacementBlocked") {
    return { baseline: stored.baseline, baselineSeq: stored.baseline_seq, compaction: compaction ?? null }
  }
  if (result._tag === "ReplacementReady") {
    const baselineSeq = replacementSeq ?? (yield* EventV2.latestSequence(db, sessionID))
    yield* replace(db, sessionID, baselineSeq, result.generation)
    return { baseline: result.generation.baseline, baselineSeq, compaction: compaction ?? null }
  }

  const data = { sessionID, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now, text: result.text }
  yield* commitUpdate
    ? commitUpdate({ data, snapshot: result.snapshot })
    : publishUpdate(db, events, data, result.snapshot)
  return { baseline: stored.baseline, baselineSeq: stored.baseline_seq, compaction: compaction ?? null }
})

const initializeOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
) {
  if (yield* exists(db, sessionID)) return
  const generation = yield* context.pipe(Effect.flatMap(SystemContext.initialize))
  const baselineSeq = yield* insert(db, sessionID, generation)
  return { baseline: generation.baseline, baselineSeq, compaction: null }
})

const exists = Effect.fn("SessionContextEpoch.exists")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (
    (yield* db
      .select({ sessionID: SessionContextEpochTable.session_id })
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

const find = Effect.fn("SessionContextEpoch.find")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

/**
 * The prompt this session is currently running with — the stored epoch baseline, or `undefined`
 * before the first turn.
 *
 * This is the ONE thing a prompt inspector should read. It is regenerated whenever a component
 * changes (`prepare`'s `forceReplace`), so what it returns is what the next request sends, rather
 * than a captured or synthesised message a previous version happened to leave in the transcript.
 */
export const baselineOf = Effect.fn("SessionContextEpoch.baselineOf")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* find(db, sessionID)
  return row?.baseline
})

export const reset = Effect.fn("SessionContextEpoch.reset")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .delete(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

const insert = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  generation: SystemContext.Generation,
) {
  const baselineSeq = yield* EventV2.latestSequence(db, sessionID)
  yield* db
    .insert(SessionContextEpochTable)
    .values({
      session_id: sessionID,
      baseline: generation.baseline,
      snapshot: generation.snapshot,
      baseline_seq: baselineSeq,
    })
    .run()
    .pipe(Effect.orDie)
  return baselineSeq
})

const replace = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
  generation: SystemContext.Generation,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({
      baseline: generation.baseline,
      snapshot: generation.snapshot,
      baseline_seq: baselineSeq,
    })
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .returning({ sessionID: SessionContextEpochTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Context Epoch not found")
})

export const publishUpdate = Effect.fn("SessionContextEpoch.publishUpdate")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  data: typeof SessionEvent.ContextUpdated.data.Type,
  snapshot: SystemContext.Snapshot,
) {
  yield* events.publish(SessionEvent.ContextUpdated, data, {
    commit: () => advance(db, data.sessionID, snapshot).pipe(Effect.orDie),
  })
})

const advance = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  snapshot: SystemContext.Snapshot,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({ snapshot })
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .returning({ sessionID: SessionContextEpochTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Context Epoch not found")
})
