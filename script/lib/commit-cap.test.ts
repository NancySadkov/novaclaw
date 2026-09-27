import { describe, expect, test } from "bun:test"
import {
  KILL_FACTOR,
  killCapMb,
  killCapMbForBox,
  MACHINE_ALLOWANCE_MB,
  MAX_KILL_CAP_FRACTION_OF_COMMIT,
  MIN_KILL_CAP_MB,
} from "./commit-cap"

describe("killCapMb", () => {
  test("caps at twice the unit's worst healthy run", () => {
    // A unit small enough that 2× its peak is under BOTH bounds, so the anchor is what binds.
    expect(killCapMb(3000)).toBe(KILL_FACTOR * 3000)
    // …and one so small that even 2× is under the floor, which exists so a first measurement cannot
    // produce a hair-trigger.
    expect(killCapMb(1000)).toBe(MIN_KILL_CAP_MB)
    expect(killCapMb(1000, undefined)).toBe(MIN_KILL_CAP_MB)
  })

  test("a tiny profile still gets a real ceiling, not a hair-trigger", () => {
    expect(killCapMb(100, undefined)).toBe(MIN_KILL_CAP_MB)
    expect(killCapMb(100, 32768)).toBe(MIN_KILL_CAP_MB)
  })

  test("🔴 the MACHINE ALLOWANCE binds before the profile anchor does", () => {
    // This is the whole point, and it is the number that was wrong on 2026-09-27. core's recorded
    // healthy peak is 10,822 MB, so its anchor is 21,644 MB — which on a 32 GB laptop was permitted in
    // full, because the bound used to be a FRACTION of the machine (0.625 × 32,768 = 20,480 MB). The
    // run then held ~10 GB, stayed inside that ceiling, and the host still hit 100 % commit.
    //
    // The cap is now absolute, so the allowance decides and the anchor cannot buy its way past it.
    const cap = killCapMb(10822)!
    expect(cap).toBe(MACHINE_ALLOWANCE_MB)
    expect(cap).toBeLessThan(KILL_FACTOR * 10822)
    expect(MACHINE_ALLOWANCE_MB).toBe(8_192)
  })

  test("the allowance does NOT grow with the machine", () => {
    // A fraction is the wrong shape: it scales with the box, and the thing being protected is the
    // user's session rather than the silicon. The allowance is ABSOLUTE, so a 128 GB machine gets the
    // same 8 GB promise — the box bound in `killCapMbForBox` can only tighten it, never raise it.
    expect(killCapMb(10822)).toBe(MACHINE_ALLOWANCE_MB)
    expect(killCapMbForBox(10822, 131_072)).toBe(MACHINE_ALLOWANCE_MB)
    expect(MACHINE_ALLOWANCE_MB).toBeLessThan(MAX_KILL_CAP_FRACTION_OF_COMMIT * 131_072)
  })

  test("no profile means no enforcement — measurement precedes the kill", () => {
    expect(killCapMb(undefined)).toBeUndefined()
    expect(killCapMbForBox(undefined, 32768)).toBeUndefined()
  })

  test("garbage in is no cap, never a zero cap that kills everything", () => {
    expect(killCapMb(0)).toBeUndefined()
    expect(killCapMb(-5)).toBeUndefined()
    expect(killCapMb(NaN)).toBeUndefined()
    // A nonsense allowance is IGNORED rather than honoured: it must never become a way to remove the cap.
    expect(killCapMb(10822, 0)).toBe(MACHINE_ALLOWANCE_MB)
    expect(killCapMb(10822, NaN)).toBe(MACHINE_ALLOWANCE_MB)
  })

  test("the box bound can only TIGHTEN the allowance, never loosen it", () => {
    // On a small box the fraction is below the allowance and becomes the binding line — which is the
    // correct direction: the machine is the constraint.
    expect(killCapMbForBox(10822, 8192)).toBe(Math.floor(MAX_KILL_CAP_FRACTION_OF_COMMIT * 8192))
    // On a large box the allowance is the binding line, so the fraction is ignored.
    expect(killCapMbForBox(10822, 131_072)).toBe(MACHINE_ALLOWANCE_MB)
    expect(killCapMbForBox(10822, undefined)).toBe(MACHINE_ALLOWANCE_MB)
  })

  test("yesterday's arithmetic, corrected: core dies at 8 GB, not ~20 GB", () => {
    // The old assertion was `cap < limit - 6000 && cap > 10822` — i.e. it ASSERTED the ~20 GB figure
    // was safe, and passed, while the host paged and Windows reaped the user's browser and editor. A
    // test that pins the dangerous number as correct is worse than no test, so this one now pins the
    // opposite: the line is BELOW core's own healthy peak, which is the whole trade.
    const cap = killCapMb(10822)!
    expect(cap).toBeLessThan(10822)
    expect(cap).toBe(MACHINE_ALLOWANCE_MB)
  })
})
