export * as SessionWorkerInteractionBridge from "./interaction-bridge"

import { Cause, Effect, Exit, Schema } from "effect"
import { PermissionV2 } from "@novaclaw/core/permission"
import { QuestionV2 } from "@novaclaw/core/question"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"

export type Request = Extract<
  SessionWorkerProtocol.WorkerMessage,
  { readonly type: "permission-assert" | "question-ask" }
>
export type Reply = Extract<
  SessionWorkerProtocol.HostMessage,
  { readonly type: "permission-result" | "question-result" }
>

const identity = (message: Request) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
})

/** Permission and question pending maps remain location-owned in the host. The worker blocks only
 * on this RPC response; user replies continue to reach the one authoritative host service. */
export const handle = Effect.fn("SessionWorkerInteractionBridge.handle")(function* (input: {
  readonly permission: PermissionV2.Interface
  readonly question: QuestionV2.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Request
}) {
  if (!SessionWorkerProtocol.owns(input.lease, input.message)) {
    return input.message.type === "permission-assert"
      ? { ...identity(input.message), type: "permission-result" as const, outcome: "rejected" as const }
      : { ...identity(input.message), type: "question-result" as const, outcome: "rejected" as const }
  }
  if (input.message.input.sessionID !== input.lease.sessionID) {
    return input.message.type === "permission-assert"
      ? { ...identity(input.message), type: "permission-result" as const, outcome: "rejected" as const }
      : { ...identity(input.message), type: "question-result" as const, outcome: "rejected" as const }
  }

  if (input.message.type === "question-ask") {
    const asked = yield* input.question
      .ask({
        sessionID: input.lease.sessionID,
        questions: input.message.input.questions,
        ...(input.message.input.tool === undefined ? {} : { tool: input.message.input.tool }),
      })
      .pipe(Effect.exit)
    return Exit.isSuccess(asked)
      ? {
          ...identity(input.message),
          type: "question-result" as const,
          outcome: "answered" as const,
          answers: asked.value,
        }
      : { ...identity(input.message), type: "question-result" as const, outcome: "rejected" as const }
  }

  let asserted: PermissionV2.AssertInput
  try {
    asserted = Schema.decodeUnknownSync(PermissionV2.AssertInput)(input.message.input)
  } catch {
    return { ...identity(input.message), type: "permission-result" as const, outcome: "rejected" as const }
  }
  const result = yield* input.permission.assert({ ...asserted, sessionID: input.lease.sessionID }).pipe(Effect.exit)
  if (Exit.isSuccess(result))
    return { ...identity(input.message), type: "permission-result" as const, outcome: "allowed" as const }
  const error = Cause.squash(result.cause)
  if (error instanceof PermissionV2.DeniedError)
    return {
      ...identity(input.message),
      type: "permission-result" as const,
      outcome: "denied" as const,
      rules: error.rules,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    }
  if (error instanceof PermissionV2.CorrectedError)
    return {
      ...identity(input.message),
      type: "permission-result" as const,
      outcome: "corrected" as const,
      feedback: error.feedback,
    }
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "Session.NotFoundError")
    return { ...identity(input.message), type: "permission-result" as const, outcome: "session-missing" as const }
  return { ...identity(input.message), type: "permission-result" as const, outcome: "rejected" as const }
})
