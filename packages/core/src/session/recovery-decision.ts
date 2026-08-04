export * as SessionRecoveryDecision from "./recovery-decision"

import type { SessionExecutionAttempt } from "./execution-attempt"

export const FAILURE_LIMIT = 3

export type Action = "retry" | "continue" | "inspect" | "pause"
export type Reason =
  | "before-side-effect"
  | "partial-provider-output"
  | "settled-tool"
  | "replay-safe-tool"
  | "outcome-unknown"
  | "repeated-failure"

export interface Decision {
  readonly action: Action
  readonly reason: Reason
  readonly automatic: boolean
}

/** Pure recovery policy over the durable boundary. The caller supplies the failure count INCLUDING
 * the loss being classified. `automatic` is deliberately false for an uncertain tool and after the
 * per-session circuit breaker opens; neither state may be papered over by a model retry. */
export function decide(input: {
  readonly phase: SessionExecutionAttempt.Phase
  readonly checkpointed: boolean
  readonly failureCount: number
  readonly toolSideEffect?: SessionExecutionAttempt.ToolSideEffect
  readonly toolState?: "dispatched" | "settled"
}): Decision {
  if (input.failureCount >= FAILURE_LIMIT) return { action: "pause", reason: "repeated-failure", automatic: false }

  if (input.phase === "tool") {
    // A read has no side effect to duplicate. An idempotent write is easier to INSPECT and may be
    // explicitly repeated, but automatic continuation is still forbidden after any write dispatch:
    // "idempotent" describes the adapter operation, not every external system it may touch.
    if (!input.checkpointed && input.toolState === "dispatched" && input.toolSideEffect === "read")
      return { action: "retry", reason: "replay-safe-tool", automatic: true }
    return input.checkpointed
      ? { action: "continue", reason: "settled-tool", automatic: true }
      : { action: "inspect", reason: "outcome-unknown", automatic: false }
  }

  if (input.phase === "provider" && input.checkpointed)
    return { action: "continue", reason: "partial-provider-output", automatic: true }

  return { action: "retry", reason: "before-side-effect", automatic: true }
}
