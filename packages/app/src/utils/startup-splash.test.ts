import { describe, expect, test } from "bun:test"
import { SPLASH_SLOW_MS, SPLASH_STALLED_MS, splashPhase } from "./startup-splash"
import { dict } from "../i18n/en"

describe("startup splash", () => {
  test("says what is happening from the first frame", () => {
    expect(splashPhase(0)).toBe("starting")
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
    for (const key of [
      "startup.stage.desktop",
      "startup.stage.preferences",
      "startup.stage.server",
      "startup.stage.connection",
      "startup.slowNotice",
      "startup.stalledNotice",
    ] as const) {
      expect(dict[key]).toBeString()
      expect(dict[key].length).toBeGreaterThan(20)
    }
  })
})
