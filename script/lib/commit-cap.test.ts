import { describe, expect, test } from "bun:test"
import { KILL_FACTOR, killCapMb, MAX_KILL_CAP_FRACTION_OF_COMMIT, MIN_KILL_CAP_MB } from "./commit-cap"

describe("killCapMb", () => {
  test("caps at twice the unit's worst healthy run", () => {
    expect(killCapMb(10822, 32768)).toBe(
      Math.min(KILL_FACTOR * 10822, Math.floor(MAX_KILL_CAP_FRACTION_OF_COMMIT * 32768)),
    )
    expect(killCapMb(1000, undefined)).toBe(MIN_KILL_CAP_MB)
  })

  test("a tiny profile still gets a real ceiling, not a hair-trigger", () => {
    expect(killCapMb(100, undefined)).toBe(MIN_KILL_CAP_MB)
    expect(killCapMb(100, 32768)).toBe(MIN_KILL_CAP_MB)
  })

  test("the box clamp rules on a machine the profile does not fit", () => {
    // A 20 GB profile on a 32 GB box: 2× is 40 GB of imaginary protection. The clamp is what
    // actually saves the machine.
    expect(killCapMb(20000, 32768)).toBe(Math.floor(MAX_KILL_CAP_FRACTION_OF_COMMIT * 32768))
  })

  test("no profile means no enforcement — measurement precedes the kill", () => {
    expect(killCapMb(undefined, 32768)).toBeUndefined()
  })

  test("garbage in is no cap, never a zero cap that kills everything", () => {
    expect(killCapMb(0, 32768)).toBeUndefined()
    expect(killCapMb(-5, 32768)).toBeUndefined()
    expect(killCapMb(NaN, 32768)).toBeUndefined()
    expect(killCapMb(10822, 0)).toBe(KILL_FACTOR * 10822)
    expect(killCapMb(10822, NaN)).toBe(KILL_FACTOR * 10822)
  })

  test("yesterday's arithmetic: core dies at ~20 GB with room to spare", () => {
    // 2026-09-26: core committed ~31 GB on a 32 GB box. The cap below kills the unit tree at
    // ~20 GB; observed foreign demand (~6 GB) still fits underneath the limit.
    const cap = killCapMb(10822, 32768)!
    expect(cap).toBeLessThan(32768 - 6000)
    expect(cap).toBeGreaterThan(10822)
  })
})
