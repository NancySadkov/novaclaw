export * as PromptCalibration from "./prompt-calibration"

export const SAMPLE_LIMIT = 8
export const MIN_FACTOR = 1
export const MAX_FACTOR = 1.25
export const MIN_MARGIN_FRACTION = 0.02
export const MARGIN_SIGMA_MULTIPLIER = 1.5
export const MIN_MARGIN_TOKENS = 1_000

export interface Observation {
  readonly estimatedTokens: number
  readonly reportedTokens: number
}

const usable = (value: number): boolean => Number.isFinite(value) && value > 0

export const observationRatio = (observation: Observation): number | undefined => {
  if (!usable(observation.estimatedTokens) || !usable(observation.reportedTokens)) return undefined
  const ratio = observation.reportedTokens / observation.estimatedTokens
  return usable(ratio) ? ratio : undefined
}

export const retainNewest = (values: readonly number[]): readonly number[] => values.filter(usable).slice(-SAMPLE_LIMIT)

export const factorOf = (values: readonly number[]): number => {
  values = retainNewest(values)
  if (values.length === 0) return MIN_FACTOR
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const ratio = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, ratio))
}

/**
 * Adaptive uncertainty for exact-route anchored predictions.
 *
 * Each value is `reportedPromptTokens / anchoredEstimateTokens` for one settled request. These are
 * deliberately NOT the whole-request heuristic ratios used by `factorOf`: a ratio that includes a
 * fixed chat-template intercept measures estimator bias, not the residual error around the anchored
 * prediction. Until a caller has compatible residuals, the stable 2% floor is the honest fallback.
 */
export const marginFractionOf = (anchoredResidualRatios: readonly number[]): number => {
  const values = retainNewest(anchoredResidualRatios)
  if (values.length < 2) return MIN_MARGIN_FRACTION

  // Welford avoids loss of precision from subtracting two large sums. An overflowing dispersion is
  // a real fail-closed signal: `marginTokens` below turns it into the largest representable margin.
  let mean = 0
  let squaredDistance = 0
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    const delta = value - mean
    mean += delta / (index + 1)
    squaredDistance += delta * (value - mean)
  }
  const sigma = Math.sqrt(Math.max(0, squaredDistance / values.length))
  return Math.max(MIN_MARGIN_FRACTION, MARGIN_SIGMA_MULTIPLIER * sigma)
}

/** `max(1,000, estimated * max(2%, 1.5 sigma_recent))`, saturated for hostile observations. */
export const marginTokens = (estimatedTokens: number, anchoredResidualRatios: readonly number[] = []): number => {
  const estimate = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 0
  const scaled = estimate * marginFractionOf(anchoredResidualRatios)
  if (!Number.isFinite(scaled) || scaled >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  return Math.max(MIN_MARGIN_TOKENS, Math.ceil(scaled))
}
