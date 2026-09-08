/** Keep low but real throughput visible instead of rounding it into a different claim. */
export const formatTokensPerSecond = (value: number | undefined): string | undefined => {
  if (value === undefined || value <= 0) return undefined
  if (value >= 10) return String(Math.round(value))
  if (value >= 0.1) return value.toFixed(1).replace(/\.0$/, "")
  return "<0.1"
}
