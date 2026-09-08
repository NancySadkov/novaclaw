import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionExecutionTable, SessionTable } from "@novaclaw/core/session/sql"
import { SessionMessage } from "@novaclaw/core/session/message"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionExecutionAttempt.node])))

const makeSession = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({ id, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
  })

describe("SessionExecutionAttempt", () => {
  it.effect("exposes the authoritative attempt fence only inside a draining capability", () =>
    Effect.gen(function* () {
      expect(yield* SessionExecutionAttempt.currentFence()).toBeUndefined()
      const current = {
        fence: { attemptID: "exe_current", generation: 7 },
        advance: () => Effect.void,
        toolDispatched: () => Effect.void,
        toolSettled: () => Effect.void,
        providerStarted: () => Effect.void,
        providerToolProtocol: () => Effect.void,
        providerSettled: () => Effect.void,
        servedBy: () => Effect.void,
        providerRecovery: () => Effect.succeed(undefined),
      }
      expect(
        yield* SessionExecutionAttempt.currentFence().pipe(
          Effect.provideService(SessionExecutionAttempt.Current, current),
        ),
      ).toEqual(current.fence)
    }),
  )

  it.effect("atomically replaces ownership and fences stale settlement", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_execution_fence")
      yield* makeSession(sessionID)
      const attempts = yield* SessionExecutionAttempt.Service
      const first = yield* attempts.start(sessionID, "host-a")
      const second = yield* attempts.start(sessionID, "host-b")

      expect(second.generation).toBe(first.generation + 1)
      expect(yield* attempts.owns(first)).toBe(false)
      expect(yield* attempts.owns(second)).toBe(true)

      yield* attempts.advance(first, "tool", "clear")
      expect(yield* attempts.get(sessionID)).toMatchObject({ phase: "drain" })
      yield* attempts.advance(second, "tool", "clear")
      const toolBoundary = yield* attempts.get(sessionID)
      expect(toolBoundary).toMatchObject({ phase: "tool" })
      expect(toolBoundary?.checkpointAt).toBeUndefined()
      yield* attempts.toolDispatched(second, { callID: "call_write", name: "write", sideEffect: "idempotent-write" })
      expect(yield* attempts.get(sessionID)).toMatchObject({
        toolCallID: "call_write",
        toolName: "write",
        toolSideEffect: "idempotent-write",
        toolState: "dispatched",
      })
      yield* attempts.toolSettled(second, "call_write")
      expect(yield* attempts.get(sessionID)).toMatchObject({ toolState: "settled" })
      yield* attempts.advance(second, "provider", "mark")
      const checkpointed = yield* attempts.get(sessionID)
      expect(checkpointed).toMatchObject({ phase: "provider" })
      expect(checkpointed?.checkpointAt).toBeNumber()

      yield* attempts.settle(first, "settled")
      expect((yield* attempts.get(sessionID))?.state).toBe("busy")
      yield* attempts.settle(second, "failed", { classification: "runner-failure", detail: "boom" })
      expect(yield* attempts.get(sessionID)).toMatchObject({
        state: "failed",
        failureClass: "runner-failure",
        failureDetail: "boom",
        failureCount: 1,
      })
      expect(yield* attempts.list()).toEqual([expect.objectContaining({ sessionID, state: "failed" })])
      yield* attempts.authorizeRetry(sessionID)
      expect(yield* attempts.get(sessionID)).toMatchObject({
        state: "interrupted",
        failureCount: 0,
      })
    }),
  )

  it.effect("marks an expired heartbeat interrupted and resets the failure budget after success", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_execution_recover")
      yield* makeSession(sessionID)
      const attempts = yield* SessionExecutionAttempt.Service
      const stale = yield* attempts.start(sessionID, "dead-host")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionExecutionTable)
        .set({ heartbeat_at: 1 })
        .where(eq(SessionExecutionTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* attempts.recoverStale(2)).toEqual([
        {
          sessionID,
          decision: { action: "retry", reason: "before-side-effect", automatic: true },
        },
      ])
      expect(yield* attempts.get(sessionID)).toMatchObject({
        attemptID: stale.attemptID,
        state: "interrupted",
        failureClass: "before-side-effect",
        failureCount: 1,
      })

      const recovered = yield* attempts.start(sessionID, "new-host")
      yield* attempts.settle(recovered, "settled")
      expect(yield* attempts.get(sessionID)).toMatchObject({ state: "settled", failureCount: 0 })
    }),
  )

  it.effect("resumes an orphaned unsettled tool through inspection instead of replaying it", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_execution_unknown_tool")
      yield* makeSession(sessionID)
      const attempts = yield* SessionExecutionAttempt.Service
      const lease = yield* attempts.start(sessionID, "dead-tool-host")
      yield* attempts.advance(lease, "tool", "clear")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionExecutionTable)
        .set({ heartbeat_at: 1 })
        .where(eq(SessionExecutionTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* attempts.recoverStale(2)).toEqual([
        {
          sessionID,
          decision: { action: "inspect", reason: "outcome-unknown", automatic: true },
        },
      ])
      expect(yield* attempts.get(sessionID)).toMatchObject({
        state: "interrupted",
        phase: "tool",
        failureClass: "outcome-unknown",
        failureCount: 1,
      })
    }),
  )

  it.effect("keeps provider recovery on the fenced execution owner", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_execution_provider_recovery")
      yield* makeSession(sessionID)
      const attempts = yield* SessionExecutionAttempt.Service
      const first = yield* attempts.start(sessionID, "host-a")
      const recovery = {
        attemptID: EventV2.ID.create(),
        assistantMessageID: SessionMessage.ID.create(),
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        startedAt: DateTime.makeUnsafe(1234),
        toolProtocol: false,
      }
      yield* attempts.providerStarted(first, recovery)
      expect(yield* attempts.providerRecovery(first)).toEqual(recovery)
      yield* attempts.providerToolProtocol(first)
      expect(yield* attempts.providerRecovery(first)).toEqual({ ...recovery, toolProtocol: true })

      const replacement = yield* attempts.start(sessionID, "host-b")
      expect(yield* attempts.settle(replacement, "settled")).toBe("recovery-pending")
      expect(yield* attempts.get(sessionID)).toMatchObject({ state: "recovering" })
      yield* attempts.providerSettled(first, recovery.attemptID)
      expect(yield* attempts.providerRecovery(replacement)).toEqual({ ...recovery, toolProtocol: true })
      yield* attempts.providerSettled(replacement, recovery.attemptID)
      expect(yield* attempts.providerRecovery(replacement)).toBeUndefined()
      expect(yield* attempts.settle(replacement, "settled")).toBe("committed")
      expect(yield* attempts.get(sessionID)).toMatchObject({ state: "settled" })
    }),
  )

  it.effect("classifies live worker loss and opens the circuit breaker without replaying tools", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_execution_live_recovery")
      yield* makeSession(sessionID)
      const attempts = yield* SessionExecutionAttempt.Service

      const safe = yield* attempts.start(sessionID, "worker-1")
      expect(yield* attempts.recoverFailure(safe, { classification: "heartbeat-timeout" })).toEqual({
        action: "retry",
        reason: "before-side-effect",
        automatic: true,
      })
      expect(yield* attempts.get(sessionID)).toMatchObject({ state: "recovering", failureCount: 1 })

      const uncertain = yield* attempts.start(sessionID, "worker-2")
      yield* attempts.advance(uncertain, "tool", "clear")
      expect(yield* attempts.recoverFailure(uncertain, { classification: "exited" })).toEqual({
        action: "inspect",
        reason: "outcome-unknown",
        automatic: true,
      })
      expect(yield* attempts.get(sessionID)).toMatchObject({ state: "recovering", failureCount: 2 })

      const repeated = yield* attempts.start(sessionID, "worker-3")
      expect(yield* attempts.recoverFailure(repeated, { classification: "start-timeout" })).toEqual({
        action: "pause",
        reason: "repeated-failure",
        automatic: false,
      })
      expect(yield* attempts.get(sessionID)).toMatchObject({ state: "paused", failureCount: 3 })

      const replacement = yield* attempts.start(sessionID, "worker-4")
      expect(yield* attempts.recoverFailure(repeated, { classification: "late-stale" })).toBeUndefined()
      expect((yield* attempts.get(sessionID))?.attemptID).toBe(replacement.attemptID)
    }),
  )

  it.effect("counts only consecutive losses since durable forward progress", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.make("ses_execution_progress_resets_breaker")
      yield* makeSession(sessionID)
      const attempts = yield* SessionExecutionAttempt.Service

      const first = yield* attempts.start(sessionID, "worker-1")
      yield* attempts.recoverFailure(first, { classification: "pipe-loss" })
      expect((yield* attempts.get(sessionID))?.failureCount).toBe(1)

      const toolProgress = yield* attempts.start(sessionID, "worker-2")
      yield* attempts.toolDispatched(toolProgress, { callID: "call_ok", name: "bash", sideEffect: "external-unknown" })
      yield* attempts.toolSettled(toolProgress, "call_ok")
      expect((yield* attempts.get(sessionID))?.failureCount, "a completed tool resets stale failures").toBe(0)

      yield* attempts.recoverFailure(toolProgress, { classification: "later-loss" })
      expect((yield* attempts.get(sessionID))?.failureCount).toBe(1)

      const textProgress = yield* attempts.start(sessionID, "worker-3")
      const textRecovery = {
        attemptID: EventV2.ID.create(),
        assistantMessageID: SessionMessage.ID.create(),
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        startedAt: DateTime.makeUnsafe(2345),
        toolProtocol: false,
      }
      yield* attempts.providerStarted(textProgress, textRecovery)
      yield* attempts.providerSettled(textProgress, textRecovery.attemptID)
      expect((yield* attempts.get(sessionID))?.failureCount, "a completed text turn resets stale failures").toBe(0)

      const replay = yield* attempts.start(sessionID, "worker-4")
      const toolRecovery = { ...textRecovery, attemptID: EventV2.ID.create(), toolProtocol: true }
      yield* attempts.providerStarted(replay, toolRecovery)
      yield* attempts.providerSettled(replay, toolRecovery.attemptID)
      yield* attempts.recoverFailure(replay, { classification: "same-tool-loss" })
      expect(
        (yield* attempts.get(sessionID))?.failureCount,
        "producing another tool call is not progress and cannot defeat the loop breaker",
      ).toBe(1)
    }),
  )

  it.effect("retries a dispatched read and resumes every unsettled write through inspection", () =>
    Effect.gen(function* () {
      const attempts = yield* SessionExecutionAttempt.Service
      for (const [suffix, sideEffect] of [
        ["read", "read"],
        ["write", "idempotent-write"],
        ["send", "non-idempotent"],
        ["unknown", "external-unknown"],
      ] as const) {
        const sessionID = SessionSchema.ID.make(`ses_receipt_${suffix}`)
        yield* makeSession(sessionID)
        const lease = yield* attempts.start(sessionID, "host-a")
        yield* attempts.toolDispatched(lease, { callID: `call_${suffix}`, name: suffix, sideEffect })
        const decision = yield* attempts.recoverFailure(lease, { classification: "worker-exit" })
        expect(decision?.automatic).toBe(true)
        expect((yield* attempts.get(sessionID))?.state).toBe("recovering")
      }
    }),
  )

  /**
   * `cancellation` — the crash matrix's second pinned gap
   * (`session-recovery-matrix.test.ts`). A user stopping a turn mid-tool is NOT a loss, and the
   * difference is the failure budget: a loss increments it and eventually opens the per-session
   * circuit breaker, so treating stops as losses would let three ordinary cancellations pause a
   * session the user never broke.
   *
   * `execution/local.ts:102` already routes an interrupt to `settle(…, "interrupted")` rather than
   * `recoverFailure`, which is the correct half. Nothing pinned it, so nothing would notice if a
   * future refactor routed a stop through the failure path — the session would simply start pausing
   * itself, and the cause would look like flakiness.
   */
  it.effect("a user stop mid-tool settles interrupted WITHOUT spending the failure budget", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const attempts = yield* SessionExecutionAttempt.Service
      const sessionID = SessionSchema.ID.make("ses_cancel_midtool")
      yield* makeSession(sessionID)

      // The worst case on purpose: a non-idempotent effect already dispatched. If a stop were ever
      // going to be misread as a loss, this is the row where it would matter most.
      const lease = yield* attempts.start(sessionID, "host-a")
      yield* attempts.toolDispatched(lease, { callID: "call_send", name: "send", sideEffect: "non-idempotent" })

      const recovery = {
        attemptID: EventV2.ID.create(),
        assistantMessageID: SessionMessage.ID.create(),
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        startedAt: DateTime.makeUnsafe(1234),
        toolProtocol: true,
      }
      yield* attempts.providerStarted(lease, recovery)

      yield* attempts.settle(lease, "interrupted", { classification: "interrupt" })

      const after = yield* attempts.get(sessionID)
      // One durable terminal state, and it is the one that names what happened.
      expect(after?.state).toBe("interrupted")
      // ⚠️ THE assertion. Three stops must not pause a session: `FAILURE_LIMIT` is 3, so a stop that
      // spent the budget would open the breaker on the third cancellation of a perfectly healthy
      // session, and the report would call it repeated failure.
      expect(after?.failureCount, "a user stop must not spend the failure budget").toBe(0)

      const row = yield* db
        .select()
        .from(SessionExecutionTable)
        .where(eq(SessionExecutionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      // Durable, not just in-memory: recovery reads this row from a later process.
      expect(row?.state).toBe("interrupted")
      expect(row?.provider_recovery, "a user stop must not be recovered as process loss").toBeNull()

      // ⚠️ THE negative control, and the reason this test is not just the assertion above. The fix
      // narrows WHICH states charge the budget, so a version that simply stopped counting would
      // pass everything above while quietly disabling the circuit breaker. A real failure must
      // still cost — otherwise a genuinely broken session retries forever.
      const failing = SessionSchema.ID.make("ses_cancel_control")
      yield* makeSession(failing)
      const failLease = yield* attempts.start(failing, "host-a")
      yield* attempts.settle(failLease, "failed", { classification: "runner-failure" })
      expect((yield* attempts.get(failing))?.failureCount, "a real failure must still cost").toBe(1)
    }),
  )
})
