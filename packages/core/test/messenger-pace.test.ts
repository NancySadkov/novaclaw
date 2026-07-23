import { describe, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { it } from "./lib/effect"

// P1.5 gate (notes/messenger-plan.md §2.3): the traffic-rules pacer — a pure human-typing delay,
// clamped, monotonic; and a GLOBAL serialization so NovaClaw types "with one hand" (never two
// chats at once), the core anti-ban property.

describe("MessengerPace.typingDelayMs", () => {
  it.effect("clamps to [min,max], is monotonic in length, and never posts instantly", () =>
    Effect.gen(function* () {
      const empty = MessengerPace.typingDelayMs("")
      const short = MessengerPace.typingDelayMs("hi")
      const medium = MessengerPace.typingDelayMs("x".repeat(50))
      const huge = MessengerPace.typingDelayMs("x".repeat(100_000))
      expect(empty).toBe(MessengerPace.MIN_DELAY_MS)
      expect(short).toBe(MessengerPace.MIN_DELAY_MS)
      expect(huge).toBe(MessengerPace.MAX_DELAY_MS)
      expect(medium).toBeGreaterThanOrEqual(short)
      expect(medium).toBeLessThanOrEqual(huge)
      // Nothing is instant — the min is a real, non-trivial pause.
      expect(MessengerPace.MIN_DELAY_MS).toBeGreaterThan(300)
    }),
  )

  it.effect("honors custom rate options", () =>
    Effect.gen(function* () {
      const fast = MessengerPace.typingDelayMs("x".repeat(300), { charsPerSecond: 100, minMs: 0, maxMs: 100_000 })
      // 300 chars / 100 cps = 3s.
      expect(fast).toBe(3000)
    }),
  )
})

describe("MessengerPace serialization", () => {
  it.effect("runs sends one at a time across all callers (never overlapping)", () =>
    Effect.gen(function* () {
      const pacer = MessengerPace.make({ sleep: () => Effect.void }) // instant, still serialized
      const inFlight = yield* Ref.make(0)
      const maxSeen = yield* Ref.make(0)
      const task = pacer.paced(
        "message",
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
          yield* Ref.update(maxSeen, (m) => Math.max(m, now))
          yield* Effect.yieldNow // give any concurrent task a chance to interleave
          yield* Ref.update(inFlight, (n) => n - 1)
        }),
      )
      yield* Effect.all([task, task, task, task, task], { concurrency: "unbounded" })
      // If the pacer serializes, at most one task is ever in flight.
      expect(yield* Ref.get(maxSeen)).toBe(1)
    }),
  )
})

describe("MessengerPace per-account typing speed (Settings → Messengers)", () => {
  it.effect("paceFromSettings reads the speed, clamps to the safe range, defaults on empty/invalid", () =>
    Effect.sync(() => {
      expect(MessengerPace.paceFromSettings({ [MessengerPace.PACE_SETTING_KEY]: "40" })).toEqual({ charsPerSecond: 40 })
      // Above the hard ceiling clamps (a reckless value can't turn pacing off — the ban risk).
      expect(MessengerPace.paceFromSettings({ [MessengerPace.PACE_SETTING_KEY]: "9999" })).toEqual({
        charsPerSecond: MessengerPace.PACE_CPS_MAX,
      })
      expect(MessengerPace.paceFromSettings({ [MessengerPace.PACE_SETTING_KEY]: "1" })).toEqual({ charsPerSecond: MessengerPace.PACE_CPS_MIN })
      expect(MessengerPace.paceFromSettings({})).toBeUndefined()
      expect(MessengerPace.paceFromSettings({ [MessengerPace.PACE_SETTING_KEY]: "abc" })).toBeUndefined()
    }),
  )

  it.effect("a faster per-account speed shortens the typing delay for the same text", () =>
    Effect.sync(() => {
      const text = "x".repeat(120)
      const slow = MessengerPace.typingDelayMs(text, { charsPerSecond: 5 })
      const fast = MessengerPace.typingDelayMs(text, { charsPerSecond: 60 })
      expect(fast).toBeLessThan(slow) // faster typist = less delay = higher ban risk (UI warns)
    }),
  )
})
