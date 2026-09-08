export * as SessionExecutionAttempt from "./execution-attempt"

import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Option } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"
import {
  decodeServingIdentities,
  encodeServingIdentities,
  SessionExecutionTable,
  TodoSnapshotTable,
  TodoTable,
} from "./sql"
import { SessionRecoveryDecision } from "./recovery-decision"
import { SessionProviderRecovery } from "@novaclaw/schema/session-provider-recovery"
import { SystemContext } from "../system-context/index"
import { SessionMessage } from "./message"

export type State = "starting" | "busy" | "recovering" | "paused" | "failed" | "interrupted" | "settled"
export type Phase = "drain" | "provider" | "tool" | "maintenance"
export type ToolSideEffect = "read" | "idempotent-write" | "non-idempotent" | "external-unknown"

export interface Lease {
  readonly sessionID: SessionSchema.ID
  readonly attemptID: string
  readonly generation: number
  readonly ownerID: string
}

export interface Info extends Lease {
  readonly state: State
  readonly phase: Phase
  readonly heartbeatAt: number
  readonly checkpointAt?: number
  readonly failureClass?: string
  readonly failureDetail?: string
  readonly failureCount: number
  readonly toolCallID?: string
  readonly toolName?: string
  readonly toolSideEffect?: ToolSideEffect
  readonly toolState?: "dispatched" | "settled"
  readonly startedAt: number
  readonly updatedAt: number
}

export interface Recovered {
  readonly sessionID: SessionSchema.ID
  readonly decision: SessionRecoveryDecision.Decision
}

export type Settlement = "committed" | "recovery-pending" | "superseded"

export interface Interface {
  readonly start: (sessionID: SessionSchema.ID, ownerID: string) => Effect.Effect<Lease>
  readonly heartbeat: (lease: Lease, phase?: Phase) => Effect.Effect<void>
  readonly advance: (lease: Lease, phase: Phase, checkpoint: "clear" | "mark" | "keep") => Effect.Effect<void>
  readonly toolDispatched: (
    lease: Lease,
    receipt: { callID: string; name: string; sideEffect: ToolSideEffect },
  ) => Effect.Effect<void>
  readonly toolSettled: (lease: Lease, callID: string) => Effect.Effect<void>
  readonly providerStarted: (lease: Lease, recovery: SessionProviderRecovery.Info) => Effect.Effect<void>
  readonly providerToolProtocol: (lease: Lease) => Effect.Effect<void>
  readonly providerSettled: (lease: Lease, providerAttemptID: string) => Effect.Effect<void>
  readonly providerRecovery: (lease: Lease) => Effect.Effect<SessionProviderRecovery.Info | undefined>
  /**
   * Records that a serving process answered a turn of this attempt — append-if-new.
   *
   * Accumulating HERE rather than in each caller is deliberate: the drain and the worker bridge
   * are two runtimes reaching the same row, and a de-duplication rule implemented twice is one
   * that can be right in-process and wrong under the worker.
   *
   * An attempt that outlives a server restart legitimately holds more than one identity;
   * collapsing to the last would let a receipt claim one process served a turn another did.
   */
  readonly servedBy: (lease: Lease, fingerprint: string) => Effect.Effect<void>
  readonly settle: (
    lease: Lease,
    state: "settled" | "failed" | "interrupted",
    failure?: { readonly classification: string; readonly detail?: string },
  ) => Effect.Effect<Settlement>
  /** Classifies a live worker loss against its durable side-effect boundary, increments the
   * circuit-breaker budget, and records recovering/paused atomically. A fenced lease returns
   * undefined and cannot influence the replacement owner. */
  readonly recoverFailure: (
    lease: Lease,
    failure: { readonly classification: string; readonly detail?: string },
  ) => Effect.Effect<SessionRecoveryDecision.Decision | undefined>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<Info>>
  /** Records fresh operator authority and resets the automatic-recovery circuit breaker. */
  readonly authorizeRetry: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly owns: (lease: Lease) => Effect.Effect<boolean>
  readonly recoverStale: (before: number) => Effect.Effect<ReadonlyArray<Recovered>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionExecutionAttempt") {}

/** The fenced lease attached to the currently draining fiber. Runner subsystems use this tiny
 * capability instead of owning the attempt table or guessing an owner id. It is optional so the
 * runner remains usable in narrow unit tests and migrations; the authoritative local executor
 * always provides it. */
export interface CurrentInterface {
  /** Immutable identity of the drain this capability belongs to; component writes use it as a fence. */
  readonly fence: Pick<Lease, "attemptID" | "generation">
  readonly advance: (phase: Phase, checkpoint: "clear" | "mark" | "keep") => Effect.Effect<void>
  readonly toolDispatched: (receipt: {
    callID: string
    name: string
    sideEffect: ToolSideEffect
  }) => Effect.Effect<void>
  readonly toolSettled: (callID: string) => Effect.Effect<void>
  readonly providerStarted: (recovery: SessionProviderRecovery.Info) => Effect.Effect<void>
  readonly providerToolProtocol: () => Effect.Effect<void>
  readonly providerSettled: (providerAttemptID: string) => Effect.Effect<void>
  readonly providerRecovery: () => Effect.Effect<SessionProviderRecovery.Info | undefined>
  /**
   * One turn reported the process that served it.
   *
   * ⚠️ Required, not optional like `contextUpdated`. Optional would let a runtime that
   * forgets to supply it produce receipts that are silently blank on provenance — and a
   * blank field is indistinguishable from an endpoint that reports no identity.
   */
  readonly servedBy: (fingerprint: string) => Effect.Effect<void>
  readonly contextUpdated?: (input: ContextUpdate) => Effect.Effect<void>
}

export interface ContextUpdate {
  readonly messageID: SessionMessage.ID
  readonly timestamp: DateTime.Utc
  readonly text: string
  readonly snapshot: SystemContext.Snapshot
}

export class Current extends Context.Service<Current, CurrentInterface>()(
  "@novaclaw/v2/SessionExecutionAttempt/Current",
) {}

const rowInfo = (row: typeof SessionExecutionTable.$inferSelect): Info => ({
  sessionID: row.session_id,
  attemptID: row.attempt_id,
  generation: row.generation,
  ownerID: row.owner_id,
  state: row.state,
  phase: row.phase,
  heartbeatAt: row.heartbeat_at,
  ...(row.checkpoint_at === null ? {} : { checkpointAt: row.checkpoint_at }),
  ...(row.failure_class === null ? {} : { failureClass: row.failure_class }),
  ...(row.failure_detail === null ? {} : { failureDetail: row.failure_detail }),
  ...(row.tool_call_id === null ? {} : { toolCallID: row.tool_call_id }),
  ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
  ...(row.tool_side_effect === null ? {} : { toolSideEffect: row.tool_side_effect }),
  ...(row.tool_state === null ? {} : { toolState: row.tool_state }),
  failureCount: row.failure_count,
  startedAt: row.started_at,
  updatedAt: row.time_updated,
})

export const advanceCurrent = (phase: Phase, checkpoint: "clear" | "mark" | "keep" = "keep") =>
  Effect.serviceOption(Current).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (current) => current.advance(phase, checkpoint),
      }),
    ),
  )

export const toolDispatchedCurrent = (receipt: { callID: string; name: string; sideEffect: ToolSideEffect }) =>
  useCurrent((current) => current.toolDispatched(receipt), undefined)
export const toolSettledCurrent = (callID: string) => useCurrent((current) => current.toolSettled(callID), undefined)
export const currentFence = () =>
  useCurrent((current) => Effect.succeed(current.fence), undefined as CurrentInterface["fence"] | undefined)

const useCurrent = <A>(f: (current: CurrentInterface) => Effect.Effect<A>, fallback: A) =>
  Effect.serviceOption(Current).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(fallback),
        onSome: f,
      }),
    ),
  )

export const providerStartedCurrent = (recovery: SessionProviderRecovery.Info) =>
  useCurrent((current) => current.providerStarted(recovery), undefined)
export const providerToolProtocolCurrent = () => useCurrent((current) => current.providerToolProtocol(), undefined)
export const providerSettledCurrent = (providerAttemptID: string) =>
  useCurrent((current) => current.providerSettled(providerAttemptID), undefined)
/**
 * Records the process that served a turn, from the runner's finish event.
 *
 * ⚠️ NOT swallowed on failure — it dies like every other attempt write, because a `session_execution`
 * write that cannot land means the drain has lost the database it is also writing messages to. The
 * softer-looking alternative is worse: a receipt that silently omits provenance while presenting
 * itself as complete is the failure the whole receipt programme exists to prevent.
 *
 * Absent `Current` (narrow unit tests, migrations) it does nothing, like its siblings here.
 */
export const servedByCurrent = (fingerprint: string) =>
  useCurrent((current) => current.servedBy(fingerprint), undefined)

export const providerRecoveryCurrent = () =>
  useCurrent((current) => current.providerRecovery(), undefined as SessionProviderRecovery.Info | undefined)

export const contextUpdatedCurrent = (input: ContextUpdate, fallback: () => Effect.Effect<void>) =>
  Effect.serviceOption(Current).pipe(
    Effect.flatMap(
      Option.match({
        onNone: fallback,
        onSome: (current) => current.contextUpdated?.(input) ?? fallback(),
      }),
    ),
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("SessionExecutionAttempt.get")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select()
        .from(SessionExecutionTable)
        .where(eq(SessionExecutionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? rowInfo(row) : undefined
    })

    const owns = Effect.fn("SessionExecutionAttempt.owns")(function* (lease: Lease) {
      const current = yield* get(lease.sessionID)
      return current?.attemptID === lease.attemptID && current.generation === lease.generation
    })

    const list = Effect.fn("SessionExecutionAttempt.list")(function* () {
      const rows = yield* db.select().from(SessionExecutionTable).all().pipe(Effect.orDie)
      return rows.map(rowInfo)
    })

    return Service.of({
      start: Effect.fn("SessionExecutionAttempt.start")(function* (sessionID, ownerID) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const previous = yield* tx
                  .select({
                    generation: SessionExecutionTable.generation,
                    failureCount: SessionExecutionTable.failure_count,
                  })
                  .from(SessionExecutionTable)
                  .where(eq(SessionExecutionTable.session_id, sessionID))
                  .get()
                const now = Date.now()
                const attemptID = `exe_${crypto.randomUUID()}`
                const generation = (previous?.generation ?? 0) + 1
                yield* tx
                  .insert(SessionExecutionTable)
                  .values({
                    session_id: sessionID,
                    attempt_id: attemptID,
                    generation,
                    owner_id: ownerID,
                    state: "busy",
                    phase: "drain",
                    failure_count: previous?.failureCount ?? 0,
                    heartbeat_at: now,
                    started_at: now,
                    time_updated: now,
                  })
                  .onConflictDoUpdate({
                    target: SessionExecutionTable.session_id,
                    set: {
                      attempt_id: attemptID,
                      generation,
                      owner_id: ownerID,
                      state: "busy",
                      phase: "drain",
                      failure_class: null,
                      failure_detail: null,
                      // Per-ATTEMPT, like the tool columns below: the row is overwritten in place, so a
                      // provenance left standing here would be attributed to a run it never served.
                      served_by: null,
                      heartbeat_at: now,
                      checkpoint_at: null,
                      tool_call_id: null,
                      tool_name: null,
                      tool_side_effect: null,
                      tool_state: null,
                      started_at: now,
                      time_updated: now,
                    },
                  })
                  .run()
                /**
                 * Freeze the declared plan for THIS attempt.
                 *
                 * 🔴 In the SAME transaction that opens the attempt, and that is the whole
                 * correctness argument. The `todo` list is per SESSION and the model edits it while
                 * the attempt runs, so a snapshot taken a moment later is already a different plan —
                 * a receipt would then name the plan as it ENDED and call it what was declared.
                 *
                 * ⚠️ Ordered by `position`, and the copy preserves it, because a plan whose steps
                 * come back in storage order is not a plan.
                 */
                const declared = yield* tx
                  .select({
                    content: TodoTable.content,
                    status: TodoTable.status,
                    priority: TodoTable.priority,
                    position: TodoTable.position,
                  })
                  .from(TodoTable)
                  .where(eq(TodoTable.session_id, sessionID))
                  .orderBy(TodoTable.position)
                  .all()
                if (declared.length > 0)
                  yield* tx
                    .insert(TodoSnapshotTable)
                    .values(
                      declared.map((item) => ({
                        attempt_id: attemptID,
                        content: item.content,
                        status: item.status,
                        priority: item.priority,
                        position: item.position,
                        time_created: now,
                        time_updated: now,
                      })),
                    )
                    // An attempt id is fresh per attempt, so a conflict means a RETRY of the same
                    // open — take the newer read rather than failing the attempt over bookkeeping.
                    .onConflictDoUpdate({
                      target: [TodoSnapshotTable.attempt_id, TodoSnapshotTable.position],
                      set: { content: sql`excluded.content`, status: sql`excluded.status` },
                    })
                    .run()
                return { sessionID, attemptID, generation, ownerID }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      heartbeat: Effect.fn("SessionExecutionAttempt.heartbeat")(function* (lease, phase) {
        const now = Date.now()
        yield* db
          .update(SessionExecutionTable)
          .set({ heartbeat_at: now, time_updated: now, ...(phase === undefined ? {} : { phase }) })
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      advance: Effect.fn("SessionExecutionAttempt.advance")(function* (lease, phase, checkpoint) {
        const now = Date.now()
        yield* db
          .update(SessionExecutionTable)
          .set({
            state: "busy",
            phase,
            heartbeat_at: now,
            ...(checkpoint === "clear" ? { checkpoint_at: null } : checkpoint === "mark" ? { checkpoint_at: now } : {}),
            time_updated: now,
          })
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      toolDispatched: Effect.fn("SessionExecutionAttempt.toolDispatched")(function* (lease, receipt) {
        const now = Date.now()
        yield* db
          .update(SessionExecutionTable)
          .set({
            state: "busy",
            phase: "tool",
            checkpoint_at: null,
            tool_call_id: receipt.callID,
            tool_name: receipt.name,
            tool_side_effect: receipt.sideEffect,
            tool_state: "dispatched",
            heartbeat_at: now,
            time_updated: now,
          })
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      toolSettled: Effect.fn("SessionExecutionAttempt.toolSettled")(function* (lease, callID) {
        const now = Date.now()
        yield* db
          .update(SessionExecutionTable)
          .set({
            tool_state: "settled",
            checkpoint_at: now,
            // The breaker counts consecutive worker losses without durable forward progress, not
            // losses over a whole long-running task. A completed tool is such a boundary.
            failure_count: 0,
            heartbeat_at: now,
            time_updated: now,
          })
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
              eq(SessionExecutionTable.tool_call_id, callID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      providerStarted: Effect.fn("SessionExecutionAttempt.providerStarted")(function* (lease, recovery) {
        const now = Date.now()
        yield* db
          .update(SessionExecutionTable)
          .set({
            state: "busy",
            phase: "provider",
            checkpoint_at: null,
            tool_call_id: null,
            tool_name: null,
            tool_side_effect: null,
            tool_state: null,
            provider_recovery: { ...recovery, startedAt: DateTime.toEpochMillis(recovery.startedAt) },
            heartbeat_at: now,
            time_updated: now,
          })
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      servedBy: Effect.fn("SessionExecutionAttempt.servedBy")(function* (lease, fingerprint) {
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                // Fenced on the WHOLE lease, like every other write here: a superseded owner
                // must not stamp its provenance onto the attempt that replaced it.
                const fence = and(
                  eq(SessionExecutionTable.session_id, lease.sessionID),
                  eq(SessionExecutionTable.attempt_id, lease.attemptID),
                  eq(SessionExecutionTable.generation, lease.generation),
                )
                const row = yield* tx
                  .select({ servedBy: SessionExecutionTable.served_by })
                  .from(SessionExecutionTable)
                  .where(fence)
                  .get()
                if (!row) return
                const seen = decodeServingIdentities(row.servedBy)
                // A stable server reports the same identity every turn, so this is the usual
                // path: read, recognise, write nothing.
                if (seen.includes(fingerprint)) return
                yield* tx
                  .update(SessionExecutionTable)
                  .set({
                    served_by: encodeServingIdentities([...seen, fingerprint]),
                    time_updated: Date.now(),
                  })
                  .where(fence)
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      providerToolProtocol: Effect.fn("SessionExecutionAttempt.providerToolProtocol")(function* (lease) {
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select({ recovery: SessionExecutionTable.provider_recovery })
                  .from(SessionExecutionTable)
                  .where(
                    and(
                      eq(SessionExecutionTable.session_id, lease.sessionID),
                      eq(SessionExecutionTable.attempt_id, lease.attemptID),
                      eq(SessionExecutionTable.generation, lease.generation),
                    ),
                  )
                  .get()
                if (!row?.recovery || row.recovery.toolProtocol) return
                yield* tx
                  .update(SessionExecutionTable)
                  .set({ provider_recovery: { ...row.recovery, toolProtocol: true }, time_updated: Date.now() })
                  .where(
                    and(
                      eq(SessionExecutionTable.session_id, lease.sessionID),
                      eq(SessionExecutionTable.attempt_id, lease.attemptID),
                      eq(SessionExecutionTable.generation, lease.generation),
                    ),
                  )
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      providerSettled: Effect.fn("SessionExecutionAttempt.providerSettled")(function* (lease, providerAttemptID) {
        const row = yield* db
          .select({ recovery: SessionExecutionTable.provider_recovery })
          .from(SessionExecutionTable)
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (row?.recovery?.attemptID !== providerAttemptID) return
        yield* db
          .update(SessionExecutionTable)
          .set({
            provider_recovery: null,
            // A text-only provider turn is durable forward progress. A tool-producing turn is not:
            // resetting here would let a deterministic crash in that tool replay forever because
            // every replay first completes the same provider tool call.
            ...(row.recovery.toolProtocol ? {} : { failure_count: 0 }),
            time_updated: Date.now(),
          })
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      providerRecovery: Effect.fn("SessionExecutionAttempt.providerRecovery")(function* (lease) {
        const row = yield* db
          .select({ recovery: SessionExecutionTable.provider_recovery })
          .from(SessionExecutionTable)
          .where(
            and(
              eq(SessionExecutionTable.session_id, lease.sessionID),
              eq(SessionExecutionTable.attempt_id, lease.attemptID),
              eq(SessionExecutionTable.generation, lease.generation),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row?.recovery ? { ...row.recovery, startedAt: DateTime.makeUnsafe(row.recovery.startedAt) } : undefined
      }),
      settle: Effect.fn("SessionExecutionAttempt.settle")(function* (lease, state, failure) {
        const now = Date.now()
        const fence = and(
          eq(SessionExecutionTable.session_id, lease.sessionID),
          eq(SessionExecutionTable.attempt_id, lease.attemptID),
          eq(SessionExecutionTable.generation, lease.generation),
        )
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const values = {
                state,
                heartbeat_at: now,
                checkpoint_at: state === "settled" ? now : undefined,
                failure_class: failure?.classification ?? null,
                failure_detail: failure?.detail?.slice(0, 2_000) ?? null,
                /**
                 * ⚠️ **A user stop is not a failure, and must not spend the budget.** This used to read
                 * `state === "settled" ? 0 : +1`, so every deliberate interrupt incremented — and with
                 * `FAILURE_LIMIT` at 3, three cancellations of a healthy session with no successful turn
                 * between them left the budget exhausted, so the NEXT genuine fault paused the session
                 * reporting `repeated-failure`. That is ruling 2 on the recovery report: the user's own
                 * stops described as failures.
                 *
                 * `interrupted` leaves the count UNCHANGED rather than resetting it. Resetting would let
                 * a stop erase a real failure history — two genuine losses followed by one cancellation
                 * would look like a healthy session, which is the same defect pointing the other way.
                 *
                 * ⚠️ This is the `settle` path only. `recoverFailure` also lands rows in `interrupted`
                 * when it decides an automatic retry, and there the increment is CORRECT — that state
                 * came from a loss. It does its own counting inside its transaction and does not reach
                 * here.
                 */
                ...(state === "interrupted"
                  ? { provider_recovery: null }
                  : { failure_count: state === "settled" ? 0 : sql`${SessionExecutionTable.failure_count} + 1` }),
                time_updated: now,
              }
              const committed = yield* tx
                .update(SessionExecutionTable)
                .set(values)
                // A provider latch is a durable obligation, not advisory metadata. A successful
                // terminal state while it exists is illegal at the storage boundary, regardless of
                // what any runner's cached queue snapshot claims.
                .where(state === "settled" ? and(fence, isNull(SessionExecutionTable.provider_recovery)) : fence)
                .returning({ sessionID: SessionExecutionTable.session_id })
                .get()
              if (committed) return "committed" as const
              if (state !== "settled") return "superseded" as const

              const pending = yield* tx
                .update(SessionExecutionTable)
                .set({ state: "recovering", heartbeat_at: now, time_updated: now })
                .where(and(fence, isNotNull(SessionExecutionTable.provider_recovery)))
                .returning({ sessionID: SessionExecutionTable.session_id })
                .get()
              return pending ? ("recovery-pending" as const) : ("superseded" as const)
            }),
          )
          .pipe(Effect.orDie)
      }),
      recoverFailure: Effect.fn("SessionExecutionAttempt.recoverFailure")(function* (lease, failure) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select({
                    phase: SessionExecutionTable.phase,
                    checkpointAt: SessionExecutionTable.checkpoint_at,
                    failureCount: SessionExecutionTable.failure_count,
                    toolSideEffect: SessionExecutionTable.tool_side_effect,
                    toolState: SessionExecutionTable.tool_state,
                  })
                  .from(SessionExecutionTable)
                  .where(
                    and(
                      eq(SessionExecutionTable.session_id, lease.sessionID),
                      eq(SessionExecutionTable.attempt_id, lease.attemptID),
                      eq(SessionExecutionTable.generation, lease.generation),
                    ),
                  )
                  .get()
                if (!row) return undefined
                const failureCount = row.failureCount + 1
                const decision = SessionRecoveryDecision.decide({
                  phase: row.phase,
                  checkpointed: row.checkpointAt !== null,
                  failureCount,
                  ...(row.toolSideEffect === null ? {} : { toolSideEffect: row.toolSideEffect }),
                  ...(row.toolState === null ? {} : { toolState: row.toolState }),
                })
                const now = Date.now()
                const updated = yield* tx
                  .update(SessionExecutionTable)
                  .set({
                    state: decision.automatic ? "recovering" : "paused",
                    failure_class: failure.classification,
                    failure_detail: failure.detail?.slice(0, 2_000) ?? decision.reason,
                    failure_count: failureCount,
                    heartbeat_at: now,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(SessionExecutionTable.session_id, lease.sessionID),
                      eq(SessionExecutionTable.attempt_id, lease.attemptID),
                      eq(SessionExecutionTable.generation, lease.generation),
                    ),
                  )
                  .returning({ sessionID: SessionExecutionTable.session_id })
                  .get()
                return updated ? decision : undefined
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
      get,
      list,
      authorizeRetry: Effect.fn("SessionExecutionAttempt.authorizeRetry")(function* (sessionID) {
        const now = Date.now()
        yield* db
          .update(SessionExecutionTable)
          .set({
            state: "interrupted",
            failure_class: null,
            failure_detail: null,
            failure_count: 0,
            checkpoint_at: null,
            time_updated: now,
          })
          .where(eq(SessionExecutionTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
      owns,
      recoverStale: Effect.fn("SessionExecutionAttempt.recoverStale")(function* (before) {
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const stale = yield* tx
                  .select()
                  .from(SessionExecutionTable)
                  .where(
                    and(
                      inArray(SessionExecutionTable.state, ["starting", "busy", "recovering"]),
                      lt(SessionExecutionTable.heartbeat_at, before),
                    ),
                  )
                  .all()
                const recovered: Recovered[] = []
                for (const row of stale) {
                  const failureCount = row.failure_count + 1
                  const decision = SessionRecoveryDecision.decide({
                    phase: row.phase,
                    checkpointed: row.checkpoint_at !== null,
                    failureCount,
                    ...(row.tool_side_effect === null ? {} : { toolSideEffect: row.tool_side_effect }),
                    ...(row.tool_state === null ? {} : { toolState: row.tool_state }),
                  })
                  const now = Date.now()
                  const updated = yield* tx
                    .update(SessionExecutionTable)
                    .set({
                      state: decision.automatic ? "interrupted" : "paused",
                      failure_class: decision.reason,
                      failure_detail:
                        decision.reason === "outcome-unknown"
                          ? "A tool was dispatched without a durable result; inspect its target before retrying"
                          : decision.reason === "repeated-failure"
                            ? "This session reached its recovery limit and was paused"
                            : "Execution heartbeat expired before settlement",
                      failure_count: failureCount,
                      time_updated: now,
                    })
                    .where(
                      and(
                        eq(SessionExecutionTable.session_id, row.session_id),
                        eq(SessionExecutionTable.attempt_id, row.attempt_id),
                        eq(SessionExecutionTable.generation, row.generation),
                        inArray(SessionExecutionTable.state, ["starting", "busy", "recovering"]),
                        lt(SessionExecutionTable.heartbeat_at, before),
                      ),
                    )
                    .returning({ sessionID: SessionExecutionTable.session_id })
                    .get()
                  if (updated) recovered.push({ sessionID: updated.sessionID, decision })
                }
                return recovered
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
