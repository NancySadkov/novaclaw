import { describe, expect, test } from "bun:test"
import {
  MARGIN_SIGMA_MULTIPLIER,
  MAX_FACTOR,
  MIN_FACTOR,
  MIN_MARGIN_FRACTION,
  MIN_MARGIN_TOKENS,
  SAMPLE_LIMIT,
  factorOf,
  marginFractionOf,
  marginTokens,
  observationRatio,
  retainNewest,
} from "./prompt-calibration"

describe("prompt calibration math", () => {
  test("turns one usable reported/estimated observation into a ratio", () => {
    expect(observationRatio({ estimatedTokens: 100, reportedTokens: 115 })).toBeCloseTo(1.15)
  })

  test("rejects non-finite, non-positive, and overflowing observations", () => {
    const invalid = [
      { estimatedTokens: 0, reportedTokens: 1 },
      { estimatedTokens: -1, reportedTokens: 1 },
      { estimatedTokens: Number.NaN, reportedTokens: 1 },
      { estimatedTokens: Number.POSITIVE_INFINITY, reportedTokens: 1 },
      { estimatedTokens: 1, reportedTokens: 0 },
      { estimatedTokens: 1, reportedTokens: -1 },
      { estimatedTokens: 1, reportedTokens: Number.NaN },
      { estimatedTokens: 1, reportedTokens: Number.POSITIVE_INFINITY },
      { estimatedTokens: Number.MIN_VALUE, reportedTokens: Number.MAX_VALUE },
    ]

    for (const observation of invalid) expect(observationRatio(observation)).toBeUndefined()
  })

  test("retains only the newest eight usable ratios", () => {
    expect(retainNewest([1.01, 0, 1.02, Number.NaN, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09])).toEqual([
      1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09,
    ])
    expect(retainNewest(Array.from({ length: 20 }, () => 1.1))).toHaveLength(SAMPLE_LIMIT)
  })

  test("uses the median, including the conventional midpoint for an even sample count", () => {
    expect(factorOf([1.05, 1.2, 1.1, 1.15])).toBeCloseTo(1.125)
  })

  test("defaults neutral and clamps the learned factor one-sided", () => {
    expect(factorOf([])).toBe(MIN_FACTOR)
    expect(factorOf([0.5])).toBe(MIN_FACTOR)
    expect(factorOf([10])).toBe(MAX_FACTOR)
  })

  test("keeps a separate 2 percent / 1000 token safety floor without residual evidence", () => {
    expect(marginFractionOf([])).toBe(MIN_MARGIN_FRACTION)
    expect(marginFractionOf([1.8])).toBe(MIN_MARGIN_FRACTION)
    expect(marginTokens(10_000)).toBe(MIN_MARGIN_TOKENS)
    expect(marginTokens(100_000)).toBe(2_000)
  })

  test("widens to 1.5 population sigma over only the newest eight anchored residual ratios", () => {
    const newest = [0.8, 1.2, 0.8, 1.2, 0.8, 1.2, 0.8, 1.2]
    const values = [100, ...newest]
    const expected = MARGIN_SIGMA_MULTIPLIER * 0.2
    expect(marginFractionOf(values)).toBeCloseTo(expected)
    expect(marginTokens(10_000, values)).toBeCloseTo(3_000, 0)
  })

  test("fails closed when a hostile residual makes the dispersion overflow", () => {
    expect(marginTokens(10_000, [Number.MAX_VALUE, Number.MIN_VALUE])).toBe(Number.MAX_SAFE_INTEGER)
  })
})
