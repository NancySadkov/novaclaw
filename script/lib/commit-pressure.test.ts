import { describe, expect, test } from "bun:test"
import { COMMIT_FLOOR_PCT, HOST_COMMIT_WARN_PCT, pressureLine } from "./commit-pressure"

/**
 * The defect these pin is a warning nobody reads.
 *
 * Measured 2026-08-13 over 348 unit-rows across 17 full gates: `core` has a MEDIAN host commit of
 * 74% and a max of 80%, and no other unit has ever reached 75%. So the flat 75% line fired on 15 of
 * core's 31 runs and never on anything else.
 */
describe("host-commit pressure lines", () => {
  test("🔴 a hot unit's ordinary operating point says NOTHING", () => {
    // core's median. Under the old flat line this printed a warning on roughly half its runs.
    expect(pressureLine(74, 85)).toBeUndefined()
    expect(pressureLine(80, 85)).toBeUndefined()
  })

  test("a hot unit above its OWN line warns, and names the line", () => {
    const line = pressureLine(86, 85)
    expect(line?.level).toBe("warning")
    // Without this the reader sees 86% flagged beside another unit's 74% that was not, and concludes
    // the gate is inconsistent rather than unit-aware.
    expect(line?.text).toContain("this unit's line is 85%")
  })

  test("an ordinary unit still uses the default line, with no parenthetical", () => {
    const line = pressureLine(76, HOST_COMMIT_WARN_PCT)
    expect(line?.level).toBe("warning")
    expect(line?.text).not.toContain("this unit's line")
    expect(pressureLine(74, HOST_COMMIT_WARN_PCT)).toBeUndefined()
  })

  test("🔴 the FLOOR is independent of a raised warning line", () => {
    // Raising a hot unit's warning line says "this much is normal for you". It must never say "you
    // may quietly cross the floor" — the floor is product-wide and this is the arm that keeps it so.
    const line = pressureLine(COMMIT_FLOOR_PCT, 85)
    expect(line?.level).toBe("FLOOR")
    expect(pressureLine(95, 999)?.level).toBe("FLOOR")
  })

  test("an unmeasured reading is silent, not a zero", () => {
    // `undefined` means the sampler never attributed a tick to this unit. Treating it as 0 would
    // report calm on exactly the runs where the measurement failed.
    expect(pressureLine(undefined, 75)).toBeUndefined()
  })
})
