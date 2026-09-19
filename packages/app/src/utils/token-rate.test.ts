import { describe, expect, test } from "bun:test"
import { formatTokensPerSecond } from "./token-rate"

// The shared per-second formatter for live throughput. Relocated here when the dead
// `roster-live.formatTokensPerSecond` wrapper was removed (2026-09-19) — it was the only direct test
// of these branches, and `system-load.test.ts` exercises just the >10 and fractional cases.
describe("formatTokensPerSecond", () => {
  test("an unmeasured or silent stream renders nothing, never a zero", () => {
    expect(formatTokensPerSecond(undefined)).toBeUndefined()
    expect(formatTokensPerSecond(0)).toBeUndefined()
    expect(formatTokensPerSecond(-1)).toBeUndefined()
  })

  test("whole figures lose the trailing decimal", () => {
    expect(formatTokensPerSecond(42.4)).toBe("42")
    expect(formatTokensPerSecond(10)).toBe("10")
    expect(formatTokensPerSecond(1)).toBe("1")
  })

  test("sub-ten rates keep one decimal instead of rounding into a different claim", () => {
    expect(formatTokensPerSecond(1.5)).toBe("1.5")
    expect(formatTokensPerSecond(0.25)).toBe("0.3")
    expect(formatTokensPerSecond(0.2)).toBe("0.2")
  })

  test("below a tenth stays visible as a bound, not as zero", () => {
    expect(formatTokensPerSecond(0.09)).toBe("<0.1")
    expect(formatTokensPerSecond(0.001)).toBe("<0.1")
  })
})
