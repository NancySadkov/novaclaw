import { afterEach, describe, expect, test } from "bun:test"
import { LogSettings } from "@novaclaw/core/observability/log-settings"

/**
 * `apply` takes a stored value without decoding, and the 1–365 bound on `retention_days` lives on
 * the write path only. The writer reads `maxAgeMs()` on every flush; a zero there would rotate,
 * gzip and sweep every time. The clamp is what makes the reader safe whichever door wrote the row.
 */
afterEach(() => LogSettings.apply({}))

describe("log retention as the writer reads it", () => {
  test("🔴 a stored 0 is read as one day, never as rotate-on-every-flush", () => {
    LogSettings.apply({ retention_days: 0 })
    expect(LogSettings.maxAgeMs()).toBe(24 * 60 * 60 * 1000)
  })
  test("a negative or fractional value cannot go below a day either", () => {
    LogSettings.apply({ retention_days: -3 })
    expect(LogSettings.maxAgeMs()).toBe(24 * 60 * 60 * 1000)
    LogSettings.apply({ retention_days: 0.25 })
    expect(LogSettings.maxAgeMs()).toBe(24 * 60 * 60 * 1000)
  })
  test("an in-range value is honoured, and the default is not the clamp", () => {
    LogSettings.apply({ retention_days: 7 })
    expect(LogSettings.maxAgeMs()).toBe(7 * 24 * 60 * 60 * 1000)
    LogSettings.apply({})
    expect(LogSettings.maxAgeMs()).toBeGreaterThan(24 * 60 * 60 * 1000)
  })
})
