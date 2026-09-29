import { describe, expect, test } from "bun:test"
import {
  BACKOFF_RESET_ALIVE_MS,
  FAST_CRASH_GIVEUP,
  HISTORY_RESET_ALIVE_MS,
  LIVENESS_FAILURE_LIMIT,
  RESTART_BACKOFF_CAP_MS,
  RESTART_BACKOFF_START_MS,
  SLOW_CRASH_GIVEUP,
  initialSuperviseState,
  livenessDecision,
  superviseDecision,
  type SuperviseState,
} from "./supervise"

// Dependability P4: the serve-supervision restart policy. These pin the CONTRACT — clean exits are
// never fought, the backoff ladder grows to a cap and resets on stability, and a crash loop gives
// up gracefully instead of spinning forever on (e.g.) a foreign-held port.
//
// 🔴 The contract has TWO crash ladders, because a crash loop has two shapes. See the measured case in
// `SLOW_CRASH_GIVEUP`: a child that lives for minutes and then dies is a fault, and the old policy
// scored every one of those as a healthy first start.

describe("superviseDecision", () => {
  test("exit 0 stops — an intentional shutdown is never restarted", () => {
    expect(superviseDecision(initialSuperviseState, { code: 0, aliveMs: 50 })).toEqual({ action: "stop-clean" })
    expect(
      superviseDecision({ fastCrashes: 4, slowCrashes: 2, backoffMs: 30_000 }, { code: 0, aliveMs: 999_999 }),
    ).toEqual({ action: "stop-clean" })
  })

  test("a crash restarts after the current backoff, and the next backoff doubles up to the cap", () => {
    // ⚠️ `aliveMs` is one second under `BACKOFF_RESET_ALIVE_MS` (60 s) so the backoff does not reset
    // each round — but also far under the history window, so the slow ladder is not what is under
    // test here. The state is advanced by hand rather than by looping, because with both crash ladders
    // now bounded no single fault sequence reaches the cap: a loop would stop on a giveup long before
    // the backoff did, and the curve below would be untestable.
    const delays: number[] = []
    let backoffMs = RESTART_BACKOFF_START_MS
    const longLife = BACKOFF_RESET_ALIVE_MS - 1
    for (let i = 0; i < 10; i++) {
      const d = superviseDecision({ fastCrashes: 0, slowCrashes: 0, backoffMs }, { code: 1, aliveMs: longLife })
      if (d.action !== "restart") throw new Error(`unexpected action at ${i}: ${d.action}`)
      delays.push(d.delayMs)
      backoffMs = d.next.backoffMs
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000])
    expect(RESTART_BACKOFF_CAP_MS).toBe(30_000)
  })

  test("a child alive past the stability window earns a backoff reset", () => {
    const climbed: SuperviseState = { fastCrashes: 0, slowCrashes: 0, backoffMs: 16_000 }
    const d = superviseDecision(climbed, { code: 1, aliveMs: BACKOFF_RESET_ALIVE_MS })
    if (d.action !== "restart") throw new Error("expected restart")
    expect(d.delayMs).toBe(RESTART_BACKOFF_START_MS)
  })

  test("five consecutive fast crashes give up; a slow crash re-arms the counter", () => {
    let state: SuperviseState = initialSuperviseState
    for (let i = 0; i < FAST_CRASH_GIVEUP - 1; i++) {
      const d = superviseDecision(state, { code: 1, aliveMs: 100 })
      if (d.action !== "restart") throw new Error(`expected restart at fast crash ${i + 1}`)
      state = d.next
    }
    // a slow crash resets the streak…
    const slow = superviseDecision(state, { code: 1, aliveMs: 15_000 })
    if (slow.action !== "restart") throw new Error("expected restart")
    expect(slow.next.fastCrashes).toBe(0)
    // …but five in a row without one gives up
    state = initialSuperviseState
    let gaveUp = false
    for (let i = 0; i < FAST_CRASH_GIVEUP; i++) {
      const d = superviseDecision(state, { code: 1, aliveMs: 100 })
      if (d.action === "giveup") {
        gaveUp = i === FAST_CRASH_GIVEUP - 1
        break
      }
      if (d.action !== "restart") throw new Error("unexpected action")
      state = d.next
    }
    expect(gaveUp).toBe(true)
  })

  test("🔴 a child that lives for MINUTES and dies is still a fault, and the loop is bounded", () => {
    // THE MEASURED CASE, 2026-09-29. A live instance restarted its server child at 01:18, 01:54 and
    // 02:09 — `code 1` each time, ~6 minutes apart — and the desktop log carried `sidecar exited
    // (code 1) - restarting in 1s` on that cycle back to 2026-09-23. `fastCrashes` reset at 10 s, so
    // every six-minute life scored as a clean first start and `FAST_CRASH_GIVEUP` was unreachable in
    // precisely the case it exists for. The loop was structurally invisible to its own guard.
    let state: SuperviseState = initialSuperviseState
    let gaveUpAt: number | undefined
    for (let attempt = 1; attempt <= 12; attempt++) {
      const d = superviseDecision(state, { code: 1, aliveMs: 6 * 60_000 })
      if (d.action === "giveup") {
        gaveUpAt = attempt
        break
      }
      if (d.action !== "restart") throw new Error("unexpected action")
      state = d.next
    }
    // Bounded, and bounded well inside the window a person would have noticed.
    expect(gaveUpAt).toBe(SLOW_CRASH_GIVEUP)
    expect(gaveUpAt).toBeLessThan(6)
  })

  test("a child that survives the history window is forgiven, and the loop starts clean again", () => {
    // The point of the long window: a server doing real work for an hour is not crash-looping. If it
    // dies then, that is a first fault, not the fourth.
    let state: SuperviseState = initialSuperviseState
    for (let i = 0; i < SLOW_CRASH_GIVEUP - 1; i++) {
      const d = superviseDecision(state, { code: 1, aliveMs: 6 * 60_000 })
      if (d.action !== "restart") throw new Error("expected restart")
      state = d.next
    }
    expect(state.slowCrashes).toBe(SLOW_CRASH_GIVEUP - 1)
    const forgiven = superviseDecision(state, { code: 1, aliveMs: HISTORY_RESET_ALIVE_MS })
    if (forgiven.action !== "restart") throw new Error("expected restart")
    expect(forgiven.next.slowCrashes).toBe(0)
    expect(forgiven.next.fastCrashes).toBe(0)
  })

  test("a boot-crash loop is still reported as a boot-crash loop, not a slow one", () => {
    // The fast ladder is checked FIRST, so a child dying in 100 ms repeatedly keeps its own, more
    // specific diagnosis: a bad path or an occupied port, not "ran a while and died".
    let state: SuperviseState = initialSuperviseState
    for (let i = 0; i < FAST_CRASH_GIVEUP; i++) {
      const d = superviseDecision(state, { code: 1, aliveMs: 100 })
      if (d.action === "giveup") {
        expect(i).toBe(FAST_CRASH_GIVEUP - 1)
        // It gave up on the FAST count, having never accumulated a slow one.
        expect(state.slowCrashes).toBe(0)
        return
      }
      // Narrowed here rather than at the call: the union's other arms have no `next`, and a `stop-clean`
      // inside this loop is a policy change worth failing on loudly rather than skipping past.
      if (d.action !== "restart") throw new Error(`unexpected action at fast crash ${i + 1}: ${d.action}`)
      state = d.next
    }
    throw new Error("expected the fast ladder to give up")
  })

  test("the history window is longer than the backoff reset, so the two cannot disagree", () => {
    // The original defect was TWO forgiveness thresholds at 10 s and 60 s, which meant a child could
    // be "healthy" for backoff purposes and "brand new" for giveup purposes simultaneously. One
    // counter, one window: the backoff reset is the shorter one and touches only the delay.
    expect(HISTORY_RESET_ALIVE_MS).toBeGreaterThan(BACKOFF_RESET_ALIVE_MS)
    expect(HISTORY_RESET_ALIVE_MS).toBeGreaterThan(6 * 60_000)
    expect(SLOW_CRASH_GIVEUP).toBeGreaterThan(0)
    expect(initialSuperviseState.slowCrashes).toBe(0)
  })
})

describe("livenessDecision", () => {
  test("restarts only after consecutive misses and a success fully re-arms it", () => {
    expect(livenessDecision(0, false)).toEqual({ action: "continue", failures: 1 })
    expect(livenessDecision(1, false)).toEqual({ action: "continue", failures: 2 })
    expect(livenessDecision(2, false)).toEqual({ action: "restart", failures: 3 })
    expect(livenessDecision(2, true)).toEqual({ action: "continue", failures: 0 })
  })
})
