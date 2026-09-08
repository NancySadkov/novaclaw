export * as CompactionBackoff from "./compaction-backoff"

/** A failed semantic summary is weak evidence that another immediate full decode will fare better. */
export const FAILURE_MS = 30 * 60 * 1_000

export const due = (retryAt: number | undefined, now: number): boolean => retryAt === undefined || retryAt <= now

export const afterFailure = (now: number): number => now + FAILURE_MS

const RETRYABLE_FAILURES = new Set(["summarizer-unavailable", "summary-unusable"])

/**
 * Apply one compaction outcome to the durable retry watermark.
 *
 * Keeping this transition here makes the runner and the starvation regression share the exact
 * policy: a semantic-summary failure opens the backoff, a successful compaction clears it, and an
 * ordinary decline leaves the current watermark alone.
 */
export const afterAttempt = (input: {
  readonly current?: number
  readonly now: number
  readonly compacted: boolean
  readonly decline?: string
}): number | undefined => {
  if (input.compacted) return undefined
  if (input.decline !== undefined && RETRYABLE_FAILURES.has(input.decline)) return afterFailure(input.now)
  return input.current
}
