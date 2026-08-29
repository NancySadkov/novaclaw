import { describe, expect, test } from "bun:test"
import { MAX_FACTOR, MIN_FACTOR, SAMPLE_LIMIT, factorOf, observationRatio, retainNewest } from "./prompt-calibration"

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
})
