import { describe, expect, test } from "bun:test"
import {
  BACKOFF_RESET_ALIVE_MS,
  FAST_CRASH_GIVEUP,
  RESTART_BACKOFF_CAP_MS,
  RESTART_BACKOFF_START_MS,
  initialSuperviseState,
  superviseDecision,
  type SuperviseState,
} from "./supervise"
import * as DesktopMirror from "../../../desktop/src/main/supervise-policy"

// Dependability P4: the serve-supervision restart policy. These pin the CONTRACT — clean exits are
// never fought, the backoff ladder grows to a cap and resets on stability, and a crash loop gives
// up gracefully instead of spinning forever on (e.g.) a foreign-held port.

describe("superviseDecision", () => {
  test("exit 0 stops — an intentional shutdown is never restarted", () => {
    expect(superviseDecision(initialSuperviseState, { code: 0, aliveMs: 50 })).toEqual({ action: "stop-clean" })
    expect(superviseDecision({ fastCrashes: 4, backoffMs: 30_000 }, { code: 0, aliveMs: 999_999 })).toEqual({
      action: "stop-clean",
    })
  })

  test("a crash restarts after the current backoff, and the next backoff doubles up to the cap", () => {
    let state: SuperviseState = initialSuperviseState
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      const d = superviseDecision(state, { code: 1, aliveMs: 20_000 }) // slow-ish crashes, no giveup
      if (d.action !== "restart") throw new Error("expected restart")
      delays.push(d.delayMs)
      state = d.next
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
    expect(RESTART_BACKOFF_CAP_MS).toBe(30_000)
  })

  test("a child alive past the stability window earns a backoff reset", () => {
    const climbed: SuperviseState = { fastCrashes: 0, backoffMs: 16_000 }
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

  test("the desktop sidecar policy mirror (P3) has NOT drifted from this one", () => {
    // The desktop main bundle carries a copy instead of a package edge — this pins the twins.
    const scenarios = [
      { code: 0, aliveMs: 5 },
      { code: 1, aliveMs: 5 },
      { code: 1, aliveMs: 12_000 },
      { code: 1, aliveMs: BACKOFF_RESET_ALIVE_MS },
      { code: 137, aliveMs: 100 },
    ]
    const states: SuperviseState[] = [
      initialSuperviseState,
      { fastCrashes: 3, backoffMs: 8_000 },
      { fastCrashes: 4, backoffMs: 30_000 },
    ]
    for (const state of states)
      for (const exit of scenarios)
        expect(DesktopMirror.superviseDecision(state, exit)).toEqual(superviseDecision(state, exit))
    expect(DesktopMirror.initialSuperviseState).toEqual(initialSuperviseState)
  })
})
