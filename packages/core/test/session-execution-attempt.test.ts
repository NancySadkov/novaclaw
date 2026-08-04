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

  it.effect("pauses an orphaned unsettled tool instead of replaying it", () =>
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
          decision: { action: "inspect", reason: "outcome-unknown", automatic: false },
        },
      ])
      expect(yield* attempts.get(sessionID)).toMatchObject({
        state: "paused",
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
      yield* attempts.providerSettled(first, recovery.attemptID)
      expect(yield* attempts.providerRecovery(replacement)).toEqual({ ...recovery, toolProtocol: true })
      yield* attempts.providerSettled(replacement, recovery.attemptID)
      expect(yield* attempts.providerRecovery(replacement)).toBeUndefined()
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
        automatic: false,
      })
      expect(yield* attempts.get(sessionID)).toMatchObject({ state: "paused", failureCount: 2 })

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

  it.effect("retries a dispatched read but pauses every unsettled write", () =>
    Effect.gen(function* () {
      const attempts = yield* SessionExecutionAttempt.Service
      for (const [suffix, sideEffect, automatic] of [
        ["read", "read", true],
        ["write", "idempotent-write", false],
        ["send", "non-idempotent", false],
        ["unknown", "external-unknown", false],
      ] as const) {
        const sessionID = SessionSchema.ID.make(`ses_receipt_${suffix}`)
        yield* makeSession(sessionID)
        const lease = yield* attempts.start(sessionID, "host-a")
        yield* attempts.toolDispatched(lease, { callID: `call_${suffix}`, name: suffix, sideEffect })
        const decision = yield* attempts.recoverFailure(lease, { classification: "worker-exit" })
        expect(decision?.automatic).toBe(automatic)
        expect((yield* attempts.get(sessionID))?.state).toBe(automatic ? "recovering" : "paused")
      }
    }),
  )
})
