import { describe, expect, test } from "bun:test"
import { DEFAULT_MAX_UPTIME_MS, parseMaxUptime, shouldRotate } from "../src/util/max-uptime"

/**
 * The rotation bound is the product's coarse protection against a leak nobody has found yet, so the
 * two ways it could silently stop working are pinned here: a duration that parses to the wrong
 * number (or `NaN`), and a deadline comparison that never fires.
 */
describe("parseMaxUptime", () => {
  test("defaults to 24 hours when the flag is absent", () => {
    expect(parseMaxUptime(undefined)).toBe(DEFAULT_MAX_UPTIME_MS)
    expect(DEFAULT_MAX_UPTIME_MS).toBe(86_400_000)
  })

  test("reads the unit the caller wrote", () => {
    expect(parseMaxUptime("24h")).toBe(86_400_000)
    expect(parseMaxUptime("90m")).toBe(5_400_000)
    expect(parseMaxUptime("30s")).toBe(30_000)
    expect(parseMaxUptime("7d")).toBe(604_800_000)
    expect(parseMaxUptime("1500ms")).toBe(1_500)
    expect(parseMaxUptime("1.5h")).toBe(5_400_000)
  })

  test("a bare number is milliseconds, never hours", () => {
    // A unit the caller did not write must not be invented: `3600` is one hour's worth of ms, and
    // treating it as 3600 hours would be a 150-day rotation nobody asked for.
    expect(parseMaxUptime(3_600_000)).toBe(3_600_000)
    expect(parseMaxUptime("3600000")).toBe(3_600_000)
  })

  test("off and zero disable rotation", () => {
    expect(parseMaxUptime("off")).toBe(0)
    expect(parseMaxUptime("0")).toBe(0)
    expect(parseMaxUptime(0)).toBe(0)
  })

  test("a malformed bound THROWS rather than disabling the guard", () => {
    // The whole point: a bound that silently became NaN/undefined would turn the protection off
    // exactly when someone tried to configure it.
    for (const bad of ["-1h", "1w", "h", "24 h", "soon", "1e3"]) {
      expect(() => parseMaxUptime(bad)).toThrow()
    }
  })
})

describe("shouldRotate", () => {
  const start = 1_000

  test("fires at the bound, not before", () => {
    expect(shouldRotate({ startedAt: start, now: start + 999, maxUptimeMs: 1_000 })).toBe(false)
    expect(shouldRotate({ startedAt: start, now: start + 1_000, maxUptimeMs: 1_000 })).toBe(true)
  })

  test("zero disables it", () => {
    expect(shouldRotate({ startedAt: start, now: start + 10_000_000, maxUptimeMs: 0 })).toBe(false)
  })

  test("a backwards clock does not rotate", () => {
    expect(shouldRotate({ startedAt: 5_000, now: 1_000, maxUptimeMs: 1_000 })).toBe(false)
  })
})
