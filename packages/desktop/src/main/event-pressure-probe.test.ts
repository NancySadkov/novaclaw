import { describe, expect, test } from "bun:test"
import {
  classifyEventPressure,
  createEventPressureProbe,
  FLOOD_RATE_PER_SEC,
  FLOOD_SUSTAIN_MS,
  type EventPressureSample,
} from "./event-pressure-probe"

/**
 * 🔴 The measured loop this policy exists to refuse, 2026-09-29, from the owner's own logs:
 *
 *   19:55:05  renderer unresponsive
 *   19:57:01  renderer recovered by reload (attempt 1)      ← 116s
 *   19:57:01  renderer unresponsive                          ← 10ms after the reload
 *
 * with `server.global.event.overflow` and 6,712 buffered events in the same window.
 *
 * The window is reloaded INTO the condition that caused the freeze, so the remedy causes the next
 * freeze. The watchdog cannot see this: from inside it, "briefly busy" and "the thing being reloaded
 * into is the problem" are the same observation. The missing input is what the client was asked to do.
 */
const sample = (over: Partial<EventPressureSample> = {}): EventPressureSample => ({
  accepted: 0,
  bufferedAtOverflow: 0,
  windowMs: 10_000,
  overflowed: false,
  generation: 1,
  ...over,
})

describe("classifyEventPressure", () => {
  test("an idle client is healthy", () => {
    expect(classifyEventPressure(sample({ accepted: 5 }))).toEqual({ kind: "healthy" })
  })

  test("🔴 a cut with a low rate is a BURST, not a flood — and the distinction is the fix", () => {
    // This is the assertion the whole module rests on. The server shed this client; if that alone
    // read as "flood", every hiccup would trigger a reload — and the reload is what caused the loop.
    const verdict = classifyEventPressure(sample({ accepted: 20, overflowed: true, bufferedAtOverflow: 6_712 }))
    expect(verdict.kind).toBe("brief-burst")
  })

  test("a high rate sustained past the window IS a flood, and it reports the backlog", () => {
    const accepted = Math.ceil((FLOOD_RATE_PER_SEC * FLOOD_SUSTAIN_MS) / 1000) + 10
    const verdict = classifyEventPressure(
      sample({ accepted, windowMs: FLOOD_SUSTAIN_MS, overflowed: true, bufferedAtOverflow: 6_712 }),
    )
    expect(verdict).toEqual({ kind: "sustained-flood", ratePerSec: expect.any(Number), buffered: 6_712 })
  })

  test("a high rate inside a SHORT window is a burst — duration is what separates them", () => {
    // Same rate as the flood case, a tenth of the duration. Reloading here would be the mistake.
    const accepted = Math.ceil((FLOOD_RATE_PER_SEC * 10_000) / 1000) + 10
    expect(classifyEventPressure(sample({ accepted, windowMs: 1_000 })).kind).toBe("brief-burst")
  })

  test("a zero-length window cannot divide by zero and invent a flood", () => {
    // The obvious degenerate case, and the one that would make a brand-new probe report a flood on
    // its first read — which is to say, at exactly the moment a reconnecting client is least able to
    // afford a reload.
    expect(classifyEventPressure(sample({ accepted: 10_000, windowMs: 0 }))).toEqual({ kind: "healthy" })
  })

  test("the thresholds are ordered, so a flood is reachable at all", () => {
    // A vacuous policy — one that can never classify a flood — would pass every test above that
    // asserts a burst or healthy, and quietly disable the whole mechanism.
    expect(FLOOD_RATE_PER_SEC).toBeGreaterThan(0)
    expect(FLOOD_SUSTAIN_MS).toBeGreaterThan(0)
    expect(classifyEventPressure(sample({ accepted: 1_000_000, windowMs: 60_000 })).kind).toBe(
      "sustained-flood",
    )
  })
})

describe("createEventPressureProbe", () => {
  test("counts the work the main thread is actually being asked to do", () => {
    let clock = 1_000
    const probe = createEventPressureProbe({ now: () => clock })
    for (let i = 0; i < 600; i += 1) probe.acceptedEvent()
    clock += 10_000
    const verdict = probe.verdict()
    expect(verdict.kind).toBe("sustained-flood")
    if (verdict.kind !== "sustained-flood") throw new Error("unreachable")
    expect(verdict.ratePerSec).toBeCloseTo(60, 0)
  })

  test("🔴 a reconnect is a NEW generation, not a silent reset — a resync must be visible", () => {
    // The measured failure is a resync loop. If a reconnect reset the counters without changing the
    // generation, a client cycling every ten seconds would look permanently healthy and the loop
    // would be invisible to the very instrument meant to catch it.
    let clock = 0
    const probe = createEventPressureProbe({ now: () => clock })
    for (let i = 0; i < 5_000; i += 1) probe.acceptedEvent()
    clock += 30_000
    const before = probe.sample()
    probe.reconnected()
    const after = probe.sample()
    expect(after.generation).toBe(before.generation + 1)
    expect(after.accepted).toBe(0)
    expect(probe.verdict().kind).toBe("healthy")
  })

  test("the overflow count is retained, because it is the only direct measure of the backlog", () => {
    const probe = createEventPressureProbe({ now: () => 0 })
    probe.overflowed(6_712)
    expect(probe.sample().bufferedAtOverflow).toBe(6_712)
    expect(probe.sample().overflowed).toBe(true)
  })

  test("a fresh window does not forget that we were cut", () => {
    // The rate is a windowed measurement and the cut is a fact; resetting one must not erase the
    // other, or a client could launder a backlog into looking clean.
    const probe = createEventPressureProbe({ now: () => 0 })
    probe.overflowed(6_712)
    probe.resetWindow()
    expect(probe.sample().bufferedAtOverflow).toBe(6_712)
  })
})
