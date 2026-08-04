export * as SessionWorkerExecutionBridge from "./execution-bridge"

import { DateTime, Effect } from "effect"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import { SessionProviderRecovery } from "@novaclaw/schema/session-provider-recovery"

export type Request = SessionWorkerProtocol.ExecutionRequest
export type Reply = Extract<SessionWorkerProtocol.HostMessage, { readonly type: "execution-result" }>

const reply = (message: Request, outcome: Reply["outcome"], extra?: Pick<Reply, "recovery" | "error">): Reply => ({
  version: SessionWorkerProtocol.VERSION,
  type: "execution-result",
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
  outcome,
  ...extra,
})

/** Keeps execution checkpoints in the host-owned fenced row. Matching envelope identity is necessary
 * but not sufficient: the database ownership check prevents a replaced host lease from mutating it. */
export const handle = Effect.fn("SessionWorkerExecutionBridge.handle")(function* (input: {
  readonly attempts: SessionExecutionAttempt.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Request
  readonly contextUpdated?: (update: SessionExecutionAttempt.ContextUpdate) => Effect.Effect<void>
}) {
  if (!SessionWorkerProtocol.owns(input.lease, input.message) || !(yield* input.attempts.owns(input.lease)))
    return reply(input.message, "rejected", { error: "execution ownership changed" })

  switch (input.message.type) {
    case "execution-advance":
      yield* input.attempts.advance(input.lease, input.message.phase, input.message.checkpoint)
      return reply(input.message, "applied")
    case "execution-tool-dispatched":
      yield* input.attempts.toolDispatched(input.lease, {
        callID: input.message.callID,
        name: input.message.name,
        sideEffect: input.message.sideEffect,
      })
      return reply(input.message, "applied")
    case "execution-tool-settled":
      yield* input.attempts.toolSettled(input.lease, input.message.callID)
      return reply(input.message, "applied")
    case "execution-provider-started":
      yield* input.attempts.providerStarted(
        input.lease,
        SessionProviderRecovery.Info.make({
          ...input.message.recovery,
          startedAt: DateTime.makeUnsafe(input.message.recovery.startedAt),
        }),
      )
      return reply(input.message, "applied")
    case "execution-provider-tool-protocol":
      yield* input.attempts.providerToolProtocol(input.lease)
      return reply(input.message, "applied")
    case "execution-provider-settled":
      yield* input.attempts.providerSettled(input.lease, input.message.providerAttemptID)
      return reply(input.message, "applied")
    case "execution-provider-recovery": {
      const recovery = yield* input.attempts.providerRecovery(input.lease)
      return reply(input.message, "applied", {
        ...(recovery === undefined
          ? {}
          : { recovery: { ...recovery, startedAt: DateTime.toEpochMillis(recovery.startedAt) } }),
      })
    }
    case "execution-context-updated":
      if (!input.contextUpdated)
        return reply(input.message, "rejected", { error: "context update projection is unavailable" })
      yield* input.contextUpdated({
        messageID: input.message.messageID,
        timestamp: DateTime.makeUnsafe(input.message.timestamp),
        text: input.message.text,
        snapshot: input.message.snapshot,
      })
      return reply(input.message, "applied")
  }
})

export const heartbeat = Effect.fn("SessionWorkerExecutionBridge.heartbeat")(function* (input: {
  readonly attempts: SessionExecutionAttempt.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "heartbeat" }>
}) {
  if (!SessionWorkerProtocol.owns(input.lease, input.message) || !(yield* input.attempts.owns(input.lease)))
    return yield* Effect.fail(new Error("execution ownership changed"))
  yield* input.attempts.heartbeat(input.lease, input.message.phase)
})
