import { describe, expect, test } from "bun:test"
import { CompactionBackoff } from "./compaction-backoff"

describe("semantic compaction retry backoff", () => {
  test("a failed summary cannot be retried on every following tool turn", () => {
    const failedAt = 1_000
    const retryAt = CompactionBackoff.afterFailure(failedAt)
    expect(CompactionBackoff.due(retryAt, failedAt + 1)).toBe(false)
    expect(CompactionBackoff.due(retryAt, retryAt - 1)).toBe(false)
    expect(CompactionBackoff.due(retryAt, retryAt)).toBe(true)
  })

  test("a session with no failed summary may compact immediately", () => {
    expect(CompactionBackoff.due(undefined, 0)).toBe(true)
  })

  test("the named compaction outcome owns the durable retry transition", () => {
    expect(
      CompactionBackoff.afterAttempt({ now: 1_000, compacted: false, decline: "summarizer-unavailable" }),
    ).toBe(1_000 + CompactionBackoff.FAILURE_MS)
    expect(CompactionBackoff.afterAttempt({ current: 9_000, now: 1_000, compacted: true })).toBeUndefined()
    expect(
      CompactionBackoff.afterAttempt({ current: 9_000, now: 1_000, compacted: false, decline: "under-threshold" }),
    ).toBe(9_000)
  })
})
