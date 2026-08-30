import { describe, expect, test } from "bun:test"
import { HALF_WINDOW_TOLERANCE_FRACTION, WINDOW_PIN_FRACTION, classify } from "./truncation-detection"

describe("silent prompt truncation detection", () => {
  test("recognizes the observed window-minus-one pin", () => {
    expect(
      classify({
        reportedPromptTokens: 1_023,
        calibratedEstimateTokens: 3_464,
        serverContextWindow: 1_024,
      }),
    ).toMatchObject({
      status: "suspected",
      pin: "window",
      estimateDeltaTokens: 2_441,
    })
  })

  test("arms at 98% of the window without requiring the estimate to be 5% higher", () => {
    const window = 100_000
    const reported = window * WINDOW_PIN_FRACTION
    const result = classify({
      reportedPromptTokens: reported,
      calibratedEstimateTokens: reported * 0.99,
      serverContextWindow: window,
    })

    expect(result).toMatchObject({ status: "suspected", pin: "window" })
    if (result.status === "unusable") return
    expect(result.estimateDeltaTokens).toBeLessThan(0)
    expect(result.reportedWindowFraction).toBeCloseTo(WINDOW_PIN_FRACTION)
  })

  test("recognizes the context-shift half-window pin across its boundary tolerance", () => {
    const window = 32_000
    const tolerance = window * HALF_WINDOW_TOLERANCE_FRACTION

    for (const reportedPromptTokens of [window / 2 - tolerance, window / 2, window / 2 + tolerance]) {
      expect(
        classify({
          reportedPromptTokens,
          calibratedEstimateTokens: reportedPromptTokens * 1.01,
          serverContextWindow: window,
        }),
      ).toMatchObject({ status: "suspected", pin: "half-window" })
    }
  })

  test("does not turn an ordinary report just outside either pin into a warning", () => {
    const window = 10_000

    expect(
      classify({
        reportedPromptTokens: window * (0.5 + HALF_WINDOW_TOLERANCE_FRACTION) + 1,
        calibratedEstimateTokens: 9_000,
        serverContextWindow: window,
      }),
    ).toMatchObject({ status: "clear", pin: undefined })
    expect(
      classify({
        reportedPromptTokens: window * WINDOW_PIN_FRACTION - 1,
        calibratedEstimateTokens: 9_900,
        serverContextWindow: window,
      }),
    ).toMatchObject({ status: "clear", pin: undefined })
  })

  test("retains signed estimate drift for telemetry without using it as the classifier gate", () => {
    const above = classify({
      reportedPromptTokens: 5_000,
      calibratedEstimateTokens: 5_200,
      serverContextWindow: 20_000,
    })
    const belowAtPin = classify({
      reportedPromptTokens: 10_000,
      calibratedEstimateTokens: 9_500,
      serverContextWindow: 20_000,
    })

    expect(above).toMatchObject({ status: "clear", pin: undefined, estimateDeltaTokens: 200 })
    expect(belowAtPin).toMatchObject({ status: "suspected", pin: "half-window", estimateDeltaTokens: -500 })
  })

  test("rejects non-positive and non-finite inputs deterministically", () => {
    const invalid = [
      { reportedPromptTokens: 0, calibratedEstimateTokens: 1, serverContextWindow: 1 },
      { reportedPromptTokens: -1, calibratedEstimateTokens: 1, serverContextWindow: 1 },
      { reportedPromptTokens: Number.NaN, calibratedEstimateTokens: 1, serverContextWindow: 1 },
      { reportedPromptTokens: 1, calibratedEstimateTokens: 0, serverContextWindow: 1 },
      { reportedPromptTokens: 1, calibratedEstimateTokens: Number.POSITIVE_INFINITY, serverContextWindow: 1 },
      { reportedPromptTokens: 1, calibratedEstimateTokens: 1, serverContextWindow: 0 },
      { reportedPromptTokens: 1, calibratedEstimateTokens: 1, serverContextWindow: Number.NaN },
      {
        reportedPromptTokens: Number.MAX_VALUE,
        calibratedEstimateTokens: 1,
        serverContextWindow: Number.MIN_VALUE,
      },
    ]

    for (const input of invalid) {
      expect(classify(input)).toEqual({ status: "unusable", reason: "non-positive-or-non-finite-input" })
    }
  })
})
