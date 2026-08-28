import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LOOK_INTERVAL_MS, makeState, sweep } from "./sweep"
import { REFRESH_INTERVAL_MS, type Candidate } from "./refresh"

const now = 1_000_000_000
const due: Candidate = { agent: "theron", latest: now - 1, current: { observed: now - REFRESH_INTERVAL_MS - 1 } }

function deps() {
  const asked: number[] = []
  return {
    asked,
    value: {
      candidates: () => Effect.sync(() => (asked.push(1), [due])),
      recent: () => Effect.succeed("user: hi\nassistant: working"),
      label: () => Effect.succeed("reviewing the handshake"),
      write: () => Effect.void,
    },
  }
}

test("🔴 the first sweep always looks", () => {
  /**
   * A process that started because the previous one died must not wait a quarter of an interval
   * before noticing every line is stale — and on a fresh instance the first colleague to do anything
   * gets its line immediately, which is the behaviour `refresh.ts` goes out of its way to allow.
   *
   * A/B: initialise `lastLooked` to `now` and this fails.
   */
  const state = makeState()
  const d = deps()
  expect(Effect.runSync(sweep(state, d.value, now))).toEqual({ refreshed: 1, skipped: 0, failed: 0 })
  expect(d.asked).toHaveLength(1)
})

test("🔴 a second sweep inside the look interval does not even query", () => {
  // The cost control. A 30-second tick would otherwise run the activity query 360 times per useful
  // refresh — the expensive half of work it was about to skip anyway.
  const state = makeState()
  const d = deps()
  Effect.runSync(sweep(state, d.value, now))
  expect(Effect.runSync(sweep(state, d.value, now + LOOK_INTERVAL_MS - 1))).toBeUndefined()
  expect(d.asked).toHaveLength(1)
})

test("the look interval boundary is inclusive", () => {
  const state = makeState()
  const d = deps()
  Effect.runSync(sweep(state, d.value, now))
  expect(Effect.runSync(sweep(state, d.value, now + LOOK_INTERVAL_MS))).toBeDefined()
  expect(d.asked).toHaveLength(2)
})

test("looking is cheaper than refreshing, by construction", () => {
  // Derived rather than a second literal: two independently-chosen constants are two things that can
  // drift into disagreeing about how often anything happens.
  expect(LOOK_INTERVAL_MS).toBeLessThan(REFRESH_INTERVAL_MS)
  expect(REFRESH_INTERVAL_MS % LOOK_INTERVAL_MS).toBe(0)
})
