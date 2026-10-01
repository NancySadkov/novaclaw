import { describe, expect, test } from "bun:test"
import {
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  START_POLL_MS,
  STREAM_HEARTBEAT_MS,
  STREAM_START_HEARTBEAT_MS,
  reconnectDelayMs,
  streamHeartbeatMs,
  streamRetryDelayMs,
} from "./reconnect-schedule"

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

describe("streamRetryDelayMs", () => {
  test("a start polls flat, and never inherits an accumulated backoff", () => {
    // 🔴 The 29 seconds, measured 2026-09-28 across nine real boots. `reconnectDelayMs` is a pure
    // function of the failure count, and a client starting a server burns attempts against a port that
    // is not bound — so the count climbs for a reason the ladder knows nothing about, and the sleep
    // that follows outlives the moment the server became reachable.
    for (const attempt of [0, 1, 5, 8, 40, 5000]) {
      expect(streamRetryDelayMs({ attempt, starting: true }, () => 1)).toBe(START_POLL_MS)
    }
  })

  test("a start never sleeps longer than the ladder once the ladder starts to hurt", () => {
    // ⚠️ Deliberately NOT "faster than the ladder's FIRST retry". At 500ms a start is slower than an
    // outage's opening 125–250ms, and that is the right way round: a start polls a port that is not
    // bound yet, so four times a second buys nothing and is precisely the churn the ladder exists to
    // stop. What must hold is that the start never reaches the part of the schedule that outlives the
    // server coming up.
    expect(START_POLL_MS).toBeLessThan(reconnectDelayMs(4, () => 0))
    expect(START_POLL_MS).toBeLessThan(reconnectDelayMs(9, () => 0))
    for (const attempt of [4, 9, 100]) {
      expect(streamRetryDelayMs({ attempt, starting: true })).toBeLessThan(reconnectDelayMs(attempt, () => 0))
    }
  })

  test("not starting is EXACTLY the outage schedule, jitter included", () => {
    // The restraint is the whole point of the ladder and must survive this untouched. Any drift here
    // is a four-hertz reconnect storm wearing a fix's clothes.
    for (const attempt of [0, 1, 7, 20]) {
      for (const random of [() => 0, () => 0.5, () => 1]) {
        expect(streamRetryDelayMs({ attempt, starting: false }, random)).toBe(reconnectDelayMs(attempt, random))
      }
    }
  })

  test("the exhausted outage schedule really is the length of the stall it explains", () => {
    // Pins the diagnosis rather than the fix: the total a client sleeps through before its next
    // attempt, with the jitter the schedule actually applies. The four slow boots on record measured
    // 27.7s, 29.5s, 29.8s and 29.9s, and this is the band they came from.
    const total = (jitter: number) => {
      let elapsed = 0
      for (let attempt = 0; attempt < 7; attempt++) elapsed += reconnectDelayMs(attempt, () => jitter)
      return elapsed
    }
    expect(total(0)).toBeLessThan(30_000)
    expect(total(1)).toBeGreaterThan(27_000)
    // And the flat start poll beats the fastest end of that band by an order of magnitude.
    expect(START_POLL_MS).toBeLessThan(total(0) / 10)
  })
})

describe("streamHeartbeatMs", () => {
  test("🔴 a start bounds each half-open ATTEMPT, and only a start does", () => {
    // The retry cadence bounds the wait BETWEEN attempts; this bounds ONE attempt. Packaged 0.1.83
    // measured server-health at 6.6 s and client-connected at 38.4 s — a ~32 s stall whose shape is
    // two 15 s half-open attempts plus the waits between them.
    expect(streamHeartbeatMs(true)).toBe(STREAM_START_HEARTBEAT_MS)
    expect(streamHeartbeatMs(false)).toBe(STREAM_HEARTBEAT_MS)
  })

  test("the start bound is short against the idle heartbeat, and the idle heartbeat is untouched", () => {
    // A healthy quiet stream relies on the long idle bound, so the start bound must not leak into it.
    expect(STREAM_START_HEARTBEAT_MS).toBeLessThan(STREAM_HEARTBEAT_MS / 4)
    // Two bounded attempts fit inside the measured stall with room to spare, instead of consuming it.
    expect(STREAM_START_HEARTBEAT_MS * 2).toBeLessThan(32_000 / 2)
  })
})
