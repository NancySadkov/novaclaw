/** The execution states that need a user-facing recovery banner. */
export type ExecutionAttentionState = "recovering" | "paused" | "failed" | "interrupted"

export interface ExecutionAttentionLike {
  readonly state: string
  readonly failureClass?: string | undefined
}

const ATTENTION_STATES = new Set<string>(["recovering", "paused", "failed", "interrupted"])

/** Durable work remains open unless it settled or an authority explicitly interrupted it. */
export const executionKeepsTurnOpen = (attempt: ExecutionAttentionLike | undefined): boolean =>
  attempt !== undefined && attempt.state !== "settled" && attempt.failureClass !== "interrupt"

/**
 * Choose the attempt the recovery banner may present.
 *
 * `session_status` is the live answer to whether the current owner is working; the execution query
 * is a separately polled durable projection and can briefly retain the attempt that owner replaced.
 * A historical interruption must never visually claim that a chat stopped while its replacement is
 * generating. Automatic recovery is the sole working state that remains useful to show.
 */
export const visibleExecutionAttention = <T extends ExecutionAttentionLike>(
  attempt: T | undefined,
  working: boolean,
): T | undefined => {
  if (!attempt || !ATTENTION_STATES.has(attempt.state)) return undefined
  // An operator stop is a quiet, resumable state owned by the composer. Rendering it here created a
  // second control surface whose warning copy competed with the single play button that resumes it.
  if (attempt.failureClass === "interrupt") return undefined
  if (attempt.state === "recovering" && attempt.failureClass === undefined) return undefined
  if ((working || executionKeepsTurnOpen(attempt)) && attempt.state !== "recovering") return undefined
  return attempt
}
