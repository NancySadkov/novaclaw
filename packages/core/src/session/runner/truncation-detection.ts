export * as TruncationDetection from "./truncation-detection"

export const WINDOW_PIN_FRACTION = 0.98
export const HALF_WINDOW_FRACTION = 0.5
export const HALF_WINDOW_TOLERANCE_FRACTION = 0.02

export interface Input {
  readonly reportedPromptTokens: number
  readonly calibratedEstimateTokens: number
  readonly serverContextWindow: number
}

export type Pin = "window" | "half-window"

export type Classification =
  | {
      readonly status: "unusable"
      readonly reason: "non-positive-or-non-finite-input"
    }
  | {
      readonly status: "clear" | "suspected"
      readonly pin: Pin | undefined
      /** Provider-reported prompt use as a fraction of the server's configured window. */
      readonly reportedWindowFraction: number
      /** Calibrated local estimate as a fraction of the same server window. */
      readonly estimatedWindowFraction: number
      /** Signed so telemetry retains estimator direction as well as magnitude. */
      readonly estimateDeltaTokens: number
    }

const usable = (value: number): boolean => Number.isFinite(value) && value > 0

/**
 * Classify the provider's prompt-token report without relying on provider-specific response fields.
 *
 * A pin is evidence on its own. In particular, an under-counting local estimate must not suppress a
 * report parked at the server window (or its context-shift half-window). The signed estimate delta is
 * returned for drift telemetry, but deliberately is not a prerequisite for the warning signal.
 */
export function classify(input: Input): Classification {
  const { reportedPromptTokens, calibratedEstimateTokens, serverContextWindow } = input
  if (![reportedPromptTokens, calibratedEstimateTokens, serverContextWindow].every(usable)) {
    return { status: "unusable", reason: "non-positive-or-non-finite-input" }
  }

  const reportedWindowFraction = reportedPromptTokens / serverContextWindow
  const estimatedWindowFraction = calibratedEstimateTokens / serverContextWindow
  const estimateDeltaTokens = calibratedEstimateTokens - reportedPromptTokens
  if (![reportedWindowFraction, estimatedWindowFraction, estimateDeltaTokens].every(Number.isFinite)) {
    return { status: "unusable", reason: "non-positive-or-non-finite-input" }
  }

  let pin: Pin | undefined
  if (reportedPromptTokens >= serverContextWindow * WINDOW_PIN_FRACTION) {
    pin = "window"
  } else if (
    Math.abs(reportedPromptTokens - serverContextWindow * HALF_WINDOW_FRACTION) <=
    serverContextWindow * HALF_WINDOW_TOLERANCE_FRACTION
  ) {
    pin = "half-window"
  }

  return {
    status: pin === undefined ? "clear" : "suspected",
    pin,
    reportedWindowFraction,
    estimatedWindowFraction,
    estimateDeltaTokens,
  }
}
