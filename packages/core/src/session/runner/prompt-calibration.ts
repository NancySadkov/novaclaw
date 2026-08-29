export * as PromptCalibration from "./prompt-calibration"

export const SAMPLE_LIMIT = 8
export const MIN_FACTOR = 1
export const MAX_FACTOR = 1.25

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
