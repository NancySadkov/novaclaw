export * as OverflowRecoveryPolicy from "./overflow-recovery-policy"

/** One deterministic cut, followed by at most one resend. */
export const DROP_FRACTION = 0.25
const RETAIN_FRACTION = 1 - DROP_FRACTION

export interface FailureEvidence {
  readonly classification?: string
  readonly message?: string
  readonly status?: number
}

/** The exact persisted prompt-calibration identity. */
export interface CalibrationRoute {
  readonly providerID: string
  readonly wireModelID: string
  readonly serverKey: string
  readonly routeID: string
  readonly protocolID: string
}

export type StopReason =
  | "not-context-overflow"
  | "resource-exhausted"
  | "invalid-attempt"
  | "already-recovered"
  | "invalid-prompt-size"
  | "not-smaller"
  | "insufficient-reduction"

export interface Stop {
  readonly action: "stop"
  readonly reason: StopReason
}

export interface Compress {
  readonly action: "compress"
  readonly originalPromptTokens: number
  readonly targetPromptTokens: number
  readonly dropFraction: typeof DROP_FRACTION
}

export interface Retry {
  readonly action: "retry"
  readonly originalPromptTokens: number
  readonly compressedPromptTokens: number
  readonly calibration: "retain" | "invalidate"
}

export type Plan = Stop | Compress
export type Authorization = Stop | Retry

const stop = (reason: StopReason): Stop => ({ action: "stop", reason })

// A context-overflow classification is not enough when a loose 400 classifier has swallowed an
// explicit resource failure. Compaction cannot create GPU memory and would destructively rewrite
// history for a fault it cannot repair.
const resourceExhaustion = [
  /\b(?:cuda|gpu|cpu)?\s*out of memory\b/i,
  /\boom\b/i,
  /\bfailed to allocate\b.*\bbytes?\b/i,
  /\bmemory allocation (?:failed|failure)\b/i,
  /\binsufficient (?:gpu |device )?memory\b/i,
  /\b(?:cuda|gpu) memory exhausted\b/i,
]

export const isResourceExhaustion = (message: string | undefined): boolean =>
  message !== undefined && resourceExhaustion.some((pattern) => pattern.test(message))

/**
 * Decide whether the failed prompt earns the one recovery cut.
 *
 * The target is derived once from the failed prompt, never from successive failures. Callers pass
 * `recoveryAttempts = 1` after the resend, which makes a second cut impossible rather than turning
 * this into a binary search for an unknown server limit.
 */
export const plan = (input: {
  readonly failure: FailureEvidence
  readonly originalPromptTokens: number
  readonly recoveryAttempts: number
}): Plan => {
  if (input.failure.classification !== "context-overflow") return stop("not-context-overflow")
  if (isResourceExhaustion(input.failure.message)) return stop("resource-exhausted")
  if (!Number.isSafeInteger(input.recoveryAttempts) || input.recoveryAttempts < 0) return stop("invalid-attempt")
  if (input.recoveryAttempts !== 0) return stop("already-recovered")
  if (!Number.isSafeInteger(input.originalPromptTokens) || input.originalPromptTokens <= 1)
    return stop("invalid-prompt-size")
  const targetPromptTokens = Math.floor(input.originalPromptTokens * RETAIN_FRACTION)
  if (targetPromptTokens <= 0 || targetPromptTokens >= input.originalPromptTokens) return stop("invalid-prompt-size")
  return {
    action: "compress",
    originalPromptTokens: input.originalPromptTokens,
    targetPromptTokens,
    dropFraction: DROP_FRACTION,
  }
}

const normalizeServerKey = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, "") : value)

/** Prompt calibration is valid only for the exact provider/model/server wire route that produced it. */
export const sameCalibrationRoute = (left: CalibrationRoute, right: CalibrationRoute): boolean =>
  left.providerID === right.providerID &&
  left.wireModelID === right.wireModelID &&
  normalizeServerKey(left.serverKey) === normalizeServerKey(right.serverKey) &&
  left.routeID === right.routeID &&
  left.protocolID === right.protocolID

/**
 * Authorize the resend only after measuring the assembled compressed request.
 *
 * Being merely different is not enough: it must be smaller and must meet the one fixed target. This
 * rejects unchanged retries as well as compressors that grow the prompt or reclaim too little.
 */
export const authorizeRetry = (input: {
  readonly plan: Plan
  readonly compressedPromptTokens: number
  readonly failedRoute: CalibrationRoute
  readonly retryRoute: CalibrationRoute
}): Authorization => {
  if (input.plan.action === "stop") return input.plan
  if (!Number.isSafeInteger(input.compressedPromptTokens) || input.compressedPromptTokens <= 0)
    return stop("invalid-prompt-size")
  if (input.compressedPromptTokens >= input.plan.originalPromptTokens) return stop("not-smaller")
  if (input.compressedPromptTokens > input.plan.targetPromptTokens) return stop("insufficient-reduction")
  return {
    action: "retry",
    originalPromptTokens: input.plan.originalPromptTokens,
    compressedPromptTokens: input.compressedPromptTokens,
    calibration: sameCalibrationRoute(input.failedRoute, input.retryRoute) ? "retain" : "invalidate",
  }
}
