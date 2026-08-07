import { describe, expect, test } from "bun:test"
import { SPLASH_SLOW_MS, SPLASH_STALLED_MS, splashMessageKey, splashPhase } from "./splash"
import { dict } from "./i18n/en"

describe("startup splash", () => {
  test("says what is happening from the first frame", () => {
    expect(splashPhase(0)).toBe("starting")
    expect(splashMessageKey(splashPhase(0))).toBe("desktop.startup.starting")
  })

  test("escalates once the start is slower than usual", () => {
    expect(splashPhase(SPLASH_SLOW_MS - 1)).toBe("starting")
    expect(splashPhase(SPLASH_SLOW_MS)).toBe("slow")
    expect(splashPhase(SPLASH_STALLED_MS - 1)).toBe("slow")
    expect(splashPhase(SPLASH_STALLED_MS)).toBe("stalled")
    expect(splashPhase(120_000)).toBe("stalled")
  })

  /**
   * The thresholds must fire BEFORE the main process's own bounds (30 s health gate, 60 s spawn
   * stall), or the user is told it is slow only after the failure has already been decided —
   * which is the state this whole change exists to remove.
   */
  test("both thresholds land inside the main process's 30s health gate", () => {
    expect(SPLASH_SLOW_MS).toBeLessThan(SPLASH_STALLED_MS)
    expect(SPLASH_STALLED_MS).toBeLessThan(30_000)
  })

  test("every phase resolves to a real English string — a missing key renders the key itself", () => {
    for (const phase of ["starting", "slow", "stalled"] as const) {
      const key = splashMessageKey(phase)
      const value = (dict as Record<string, string>)[key]
      expect(value).toBeString()
      expect(value.length).toBeGreaterThan(20)
    }
  })
})
