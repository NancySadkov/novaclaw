import { describe, expect, test } from "bun:test"
import { RECONNECT_BASE_MS, RECONNECT_CAP_MS, reconnectDelayMs } from "./reconnect-schedule"

/**
 * ⚠️ The schedule is asserted, never slept through. A test that waits on the real clock measures the
 * machine, and a test that only asserts "it retried" cannot fail on the unbounded tree it replaced —
 * a flat 250 ms loop retries too. The failing observation has to be the SHAPE of the sequence.
 *
 * `random` is pinned per case so the jitter is not a coin flip inside an assertion.
 */
describe("reconnectDelayMs", () => {
  const ceiling = (attempt: number) => reconnectDelayMs(attempt, () => 1)

  test("the first delays grow strictly, and every delay is capped", () => {
    const first = [0, 1, 2, 3, 4].map(ceiling)

    expect(first).toEqual([250, 500, 1000, 2000, 4000])
    for (let i = 1; i < first.length; i += 1) expect(first[i]!).toBeGreaterThan(first[i - 1]!)

    // The NEGATIVE control for "capped": the same growth without a ceiling would be 250 * 2^40,
    // about 8.7 years. Every attempt out to a number no session reaches must sit at the cap.
    for (const attempt of [7, 8, 20, 100, 5000]) expect(ceiling(attempt)).toBe(RECONNECT_CAP_MS)
    expect(RECONNECT_BASE_MS * 2 ** 100).toBeGreaterThan(RECONNECT_CAP_MS)
  })

  test("the flat 250 ms cadence it replaces is no longer producible past the first attempt", () => {
    // The pre-fix tree answered 250 for EVERY attempt. This is the assertion that fails on it.
    const anyRandom = [0, 0.5, 1]
    for (const r of anyRandom) {
      for (const attempt of [3, 6, 12]) {
        expect(reconnectDelayMs(attempt, () => r)).toBeGreaterThan(RECONNECT_BASE_MS)
      }
    }
  })

  test("jitter only ever reduces a delay, and never below half its ceiling", () => {
    for (const attempt of [0, 1, 5, 9]) {
      const top = ceiling(attempt)
      expect(reconnectDelayMs(attempt, () => 0)).toBe(Math.round(top / 2))
      expect(reconnectDelayMs(attempt, () => 0.5)).toBeGreaterThanOrEqual(Math.round(top / 2))
      expect(reconnectDelayMs(attempt, () => 0.5)).toBeLessThanOrEqual(top)
      // A real Math.random draw must land in the same band — the band is the whole point of jitter.
      for (let i = 0; i < 50; i += 1) {
        const drawn = reconnectDelayMs(attempt)
        expect(drawn).toBeGreaterThanOrEqual(Math.round(top / 2))
        expect(drawn).toBeLessThanOrEqual(top)
      }
    }
  })

  test("a negative or fractional attempt cannot escape the schedule", () => {
    expect(reconnectDelayMs(-5, () => 1)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelayMs(1.9, () => 1)).toBe(500)
  })
})
