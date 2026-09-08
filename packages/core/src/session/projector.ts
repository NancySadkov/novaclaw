export * as SessionProjector from "./projector"

import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentUsage } from "../agent/usage"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionRevert } from "./revert"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { SessionContextEpoch } from "./context-epoch"
import { SessionCompactionTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionConfigColumns } from "./config-columns"
import { SessionLocationRecovery } from "./location-recovery"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

// V1-nuke slice D: the record events carry the NATIVE Session.Info; this is fromRow's inverse.
// share_url/time_compacting are no longer written (their only traffic was the V1 codec round-trip;
// the columns stay for old rows).
//
// ⚠️ That "inverse" claim was FALSE from the V1 nuke until 2026-07-29 — three columns were missing —
// and a comment is how it stayed false. It is now a test: `session-row-inverse.test.ts` round-trips
// a fully-populated Info through `sessionRow` → `fromRow` and fails naming any field that does not
// survive, so a new `Info` field added without a line here breaks loudly instead of writing NULL.
// Exported for that test only.
export function sessionRow(info: SessionSchema.Info): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    workspace_id: info.location.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.location.directory,
    path: info.subpath,
    title: info.title,
    // The per-session CONFIG columns, generated from `SESSION_CONFIG_FIELDS` — the same
    // descriptor `info.ts`'s `fromRow` reads, so the two directions cannot drift. See the ⚠️ below
    // about the four months in which they did.
    ...SessionConfigColumns.configToRow(info),
    result: info.result,
    version: info.version,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    summary_from: info.summary?.from,
    summary_to: info.summary?.to,
    summary_complete: info.summary?.complete,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    // ⚠️ THREE of the config columns above — `thinking_budget`, `surgical_edits`,
    // `ask_before_changes` — were MISSING from this function until 2026-07-29, which made the
    // "fromRow's inverse" claim false and cost the fork fix a workaround. Measured by publishing a
    // `Created` whose `Info` carried all three `true`: the projected row came back all-NULL. Their
    // only writer was `SessionEvent.FeatureSwitched`, so no create path could set them — and two of
    // the three are RESTRICTIONS, so a create that meant to restrict silently did not.
    // They are now generated from `SESSION_CONFIG_FIELDS` (`configToRow` above), so the omission is
    // no longer expressible: a config field the descriptor declares is written here by
    // construction, and one it does not declare fails to compile.
    // ⚠️ `undefined` (not `null`) is still what an unset field writes, and that is deliberate:
    // drizzle omits `undefined` keys from a SET clause, so an unrelated `setTitle`/`setMetadata`
    // round-tripping the whole `Info` does not blank every config column. `configToRow` preserves
    // that and says so at its own definition.
    provider_recovery: info.providerRecovery
      ? { ...info.providerRecovery, startedAt: DateTime.toEpochMillis(info.providerRecovery.startedAt) }
      : undefined,
    time_created: DateTime.toEpochMillis(info.time.created),
    time_updated: DateTime.toEpochMillis(info.time.updated),
    time_archived: info.time.archived ? DateTime.toEpochMillis(info.time.archived) : undefined,
  }
}

function applyUsage(db: DatabaseService, sessionID: SessionSchema.ID, value: Usage, sign = 1) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

/** Fold one finished step into the per-minute series of whichever colleague owns the session.
 *
 *  ⚠️ Best-effort by construction: an unknown session (or one with no agent bound) records nothing
 *  rather than guessing an owner. A spend row attributed to the wrong colleague is worse than a
 *  missing one — the roster's whole promise is that each number belongs to the name beside it. */
function recordAgentMinute(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  tokens: { readonly output: number; readonly reasoning: number },
  at: number,
) {
  return Effect.gen(function* () {
    const generated = AgentUsage.generatedOf(tokens)
    if (generated <= 0) return
    const row = yield* db
      .select({ agent: SessionTable.agent })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const agent = row?.agent
    if (!agent) return
    yield* AgentUsage.record(db, { agent, generated, at })
  })
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      getCompactionStatus(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "compaction-status"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "compaction-status" ? message : undefined
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      updateCompaction: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  // `seq` is stripped alongside `id` and `type` for the same reason they are: it lives in a COLUMN.
  // Letting it into `data` would mint a second copy that no write path updates, and a stale order is
  // worse than no order — `decodeRow` puts the column's value back on the way out.
  const { id, type, seq: _seq, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

/**
 * Upgrade successful pre-audit compactions into durable transcript rows.
 *
 * The overlay table is the eligibility set: a revert deletes overlays, so this repair cannot revive
 * reverted history from the immutable event journal. Started supplies the real beginning/sequence;
 * Ended's overlay row supplies the completion time and summary. `onConflictDoNothing` makes every
 * boot idempotent and leaves native audit rows entirely alone.
 */
export const backfillCompactionTranscript = Effect.fn("SessionProjector.backfillCompactionTranscript")(function* (
  db: DatabaseService,
) {
  const overlays = yield* db.select().from(SessionCompactionTable).all().pipe(Effect.orDie)
  if (overlays.length === 0) return
  const starts = yield* db
    .select({ seq: EventTable.seq, data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Compaction.Started.type, 1)))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const byMessage = new Map(
    starts.flatMap((row) => {
      const messageID = row.data.messageID
      const timestamp = row.data.timestamp
      return typeof messageID === "string" && typeof timestamp === "number"
        ? [[messageID, { seq: row.seq, timestamp }] as const]
        : []
    }),
  )
  for (const row of overlays) {
    const start = byMessage.get(row.id)
    const created = DateTime.makeUnsafe(start?.timestamp ?? row.time_created)
    const message = SessionMessage.Compaction.make({
      id: row.id,
      type: "compaction",
      reason: row.reason,
      summary: row.summary,
      recent: row.recent,
      generatedChars: row.summary.length,
      ...(row.metadata === null ? {} : { metadata: row.metadata }),
      time: { created, completed: DateTime.makeUnsafe(row.time_created) },
    })
    const encoded = encodeMessage(message)
    const { id, type, seq: _seq, ...data } = encoded
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: row.session_id,
        type,
        seq: start?.seq ?? row.seq,
        time_created: DateTime.toEpochMillis(created),
        data,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
})

/** A process restart cannot leave an operational row claiming work is still running. */
export const settleInterruptedCompactions = Effect.fn("SessionProjector.settleInterruptedCompactions")(function* (
  db: DatabaseService,
  completedAt?: DateTime.Utc,
) {
  const completed = completedAt ?? (yield* DateTime.now)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.type, "compaction-status"))
    .all()
    .pipe(Effect.orDie)
  for (const row of rows) {
    const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
    if (message.type !== "compaction-status" || message.status !== "running") continue
    const encoded = encodeMessage({
      ...message,
      status: "failed",
      failure: "process-restarted",
      time: { ...message.time, completed },
    })
    const { id: _id, type, seq: _seq, ...data } = encoded
    yield* db
      .update(SessionMessageTable)
      .set({ type, data })
      .where(eq(SessionMessageTable.id, row.id))
      .run()
      .pipe(Effect.orDie)
  }
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionRecordEvent.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.location.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.location.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
        if (event.data.openingPrompt !== undefined) {
          if (event.durable === undefined)
            return yield* Effect.die("Durable Session event is missing aggregate sequence")
          yield* SessionInput.projectAdmitted(db, {
            admittedSeq: event.durable.seq,
            id: event.data.openingPrompt.messageID,
            sessionID: event.data.sessionID,
            prompt: event.data.openingPrompt.prompt,
            delivery: event.data.openingPrompt.delivery,
            timeCreated: event.data.openingPrompt.timestamp,
          })
        }
      }),
    )
    yield* events.project(SessionRecordEvent.Updated, (event) => {
      const row = sessionRow(event.data.info)
      return db
        .update(SessionTable)
        .set(event.data.clearArchived ? { ...row, time_archived: null } : row)
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie)
    })
    yield* events.project(SessionEvent.Completed, (event) =>
      db
        .update(SessionTable)
        .set({ result: event.data.result ?? null })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionLocationRecovery.clear(db, event.data.sessionID)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionRecordEvent.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    // B10: the live control handoff — flip who answers on our side (nova ⇄ operator).
    yield* events.project(SessionEvent.ResponderSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ responder: event.data.responder, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    // 1K: mid-session permission-mode switch — the MODE_RULES overlay reads this fresh each turn.
    yield* events.project(SessionEvent.ModeSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ permission_mode: event.data.permissionMode, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.PermissionChanged, (event) => run(db, event))
    // The per-session Strict-harness override switch — the runner reads the column fresh each turn.
    yield* events.project(SessionEvent.StrictSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ strict: event.data.strict, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    // B4/T2: the per-session system-prompt override layer — same shape (null clears the column).
    yield* events.project(SessionEvent.PromptOverrideSwitched, (event) =>
      db
        .update(SessionTable)
        .set({
          system_prompt_override: event.data.override,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.DeviceSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ device: event.data.device, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.PrioritySwitched, (event) =>
      db
        .update(SessionTable)
        .set({ priority: event.data.priority, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ControlBindingSwitched, (event) =>
      db
        .update(SessionTable)
        .set({
          control_binding: event.data.controlBinding,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    // A per-session harness-feature toggle (introspection · quality · affective · thinkingBudget).
    yield* events.project(SessionEvent.FeatureSwitched, (event) => {
      const stamp = { time_updated: DateTime.toEpochMillis(event.data.timestamp) }
      const patch =
        event.data.feature === "introspection"
          ? { introspection: event.data.enabled, ...stamp }
          : event.data.feature === "quality"
            ? { quality: event.data.enabled, ...stamp }
            : event.data.feature === "thinkingBudget"
              ? { thinking_budget: event.data.enabled, ...stamp }
              : event.data.feature === "surgicalEdits"
                ? { surgical_edits: event.data.enabled, ...stamp }
                : event.data.feature === "askBeforeChanges"
                  ? { ask_before_changes: event.data.enabled, ...stamp }
                  : event.data.feature === "safeMode"
                    ? { safe_mode: event.data.enabled, ...stamp }
                    : event.data.feature === "contextBudget"
                      ? { context_budget: event.data.enabled, ...stamp }
                      : event.data.feature === "memory"
                        ? { memory: event.data.enabled, ...stamp }
                        : event.data.feature === "shortChat"
                          ? { short_chat: event.data.enabled, ...stamp }
                          : { affective: event.data.enabled, ...stamp }
      return db
        .update(SessionTable)
        .set(patch)
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event)))
    })
    // The kernel thread type (the composer's Mode control) — same shape; rootSessionType and the
    // scheduler read the column fresh, so attendance flips as soon as the row is written.
    yield* events.project(SessionEvent.TypeSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ type: event.data.sessionType, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
        // A terminal session may accept another prompt. That starts a NEW join epoch, so its old
        // result cannot remain current while the follow-up is queued/running; otherwise `wait`
        // returns the previous answer before the new turn has even begun. Completion writes the
        // next result back through the projector above.
        yield* db
          .update(SessionTable)
          .set({ result: null })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.ProviderAttempt.Started, (event) =>
      db
        .update(SessionTable)
        .set({
          provider_recovery: {
            ...event.data.recovery,
            startedAt: DateTime.toEpochMillis(event.data.recovery.startedAt),
          },
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    const clearProviderRecovery = (sessionID: SessionSchema.ID, attemptID: string) =>
      Effect.gen(function* () {
        const row = yield* db
          .select({ recovery: SessionTable.provider_recovery })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (row?.recovery?.attemptID !== attemptID) return
        yield* db
          .update(SessionTable)
          .set({ provider_recovery: null })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      })
    yield* events.project(SessionEvent.ProviderAttempt.Settled, (event) =>
      clearProviderRecovery(event.data.sessionID, event.data.attemptID),
    )
    yield* events.project(SessionEvent.ProviderAttempt.Abandoned, (event) =>
      clearProviderRecovery(event.data.sessionID, event.data.attemptID),
    )
    // F1c fork: a copied transcript message arrives as ONE self-contained durable event —
    // insert it verbatim (seq = the event's aggregate seq, so copy order is transcript order).
    yield* events.project(SessionEvent.MessageRecorded, (event) => insertMessage(db, event, event.data.message))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    // Session-level usage rollup for the NATIVE engine: fold each completed step's tokens/cost
    // into the session row. The V1 engine kept Session.tokens/cost via its step-finish part
    // projections, which never fire for session.next.* events — without this a native session's
    // record reports 0 forever (Processes token counts, the chat info sheet, cost).
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      run(db, event).pipe(
        Effect.andThen(
          applyUsage(db, event.data.sessionID, {
            cost: event.data.cost,
            tokens: {
              input: event.data.tokens.input,
              output: event.data.tokens.output,
              reasoning: event.data.tokens.reasoning,
              cache: { read: event.data.tokens.cache.read, write: event.data.tokens.cache.write },
            },
          }),
        ),
        // …and the same step lands in the colleague's PER-MINUTE series (owner, 2026-08-21). The
        // session row keeps a running TOTAL, which can answer "how much" and never "when" — a
        // roster that shows a rate needs buckets, and a total cannot be turned back into them.
        //
        // Attributed to the session's own `agent`, which a sub-agent inherits through the config
        // walk: the nameless staff spend on their officer's behalf, so the officer's row is where
        // that spend belongs.
        //
        // 🔴 A zero writes NOTHING — the rule lives in `AgentUsage.record` so every future caller
        // inherits it. A step that produced no tokens (a pure tool call, a refusal, an interrupted
        // turn) leaves no row, and an absent minute keeps meaning "nothing happened" rather than
        // "observed, and it was zero".
        // A/B: removing this line drops session-projector.test.ts to 10 pass / 1 fail.
        Effect.andThen(recordAgentMinute(db, event.data.sessionID, event.data.tokens, Date.now())),
      ),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        const row = yield* db
          .select({ recovery: SessionTable.provider_recovery })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row?.recovery || row.recovery.assistantMessageID !== event.data.assistantMessageID) return
        yield* db
          .update(SessionTable)
          .set({ provider_recovery: { ...row.recovery, toolProtocol: true } })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.Tool.Input.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Labelled, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const projection = run(db, event)
      if (event.data.failure !== undefined) return projection
      return projection.pipe(
        Effect.andThen(
          db
            .insert(SessionCompactionTable)
            .values({
              id: event.data.messageID,
              session_id: event.data.sessionID,
              seq: event.durable.seq,
              prefix_seq: event.data.prefixSeq,
              prefix_hash: event.data.prefixHash,
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
              metadata: event.metadata,
              time_created: DateTime.toEpochMillis(event.data.timestamp),
            })
            .run()
            .pipe(Effect.orDie),
        ),
      )
    })
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary =
          event.data.messageID === SessionRevert.BEFORE_ALL
            ? { seq: 0 } // revert to the empty session: delete every message/input (seq > 0)
            : yield* db
                .select({ seq: SessionMessageTable.seq })
                .from(SessionMessageTable)
                .where(
                  and(
                    eq(SessionMessageTable.session_id, event.data.sessionID),
                    eq(SessionMessageTable.id, event.data.messageID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionCompactionTable)
          .where(
            and(
              eq(SessionCompactionTable.session_id, event.data.sessionID),
              gt(SessionCompactionTable.prefix_seq, boundary.seq),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* settleInterruptedCompactions(db)
    yield* backfillCompactionTranscript(db)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
