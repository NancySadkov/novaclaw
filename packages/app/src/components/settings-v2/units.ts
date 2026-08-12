/**
 * Milliseconds are a STORAGE unit, not a thinking unit.
 *
 * settings-ux rule 3: *human units — minutes, not `300000`*. The config keeps milliseconds, which is
 * right; what was wrong is showing them to a person and asking them to count zeros. These convert at
 * the UI boundary only.
 *
 * ⚠️ **The round trip must not silently rewrite a value the user did not touch.** A stored 90 000 ms
 * is 1.5 minutes, and rounding it to 2 for display would save 120 000 the next time that row is
 * edited for any reason — a settings screen quietly changing a setting it was only showing. So the
 * display keeps a fraction when there is one, and only the trailing zeros disappear.
 */

/** Display a stored millisecond value in `unit`, keeping a fraction rather than rounding one away. */
export const fromMs = (ms: number | undefined, unitMs: number): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ""
  const value = ms / unitMs
  // `parseFloat(toFixed(3))` drops 1.5000000000000002 without turning 1.5 into 2. Three decimals is
  // past any unit a person would type and still short of float noise.
  return String(Number.parseFloat(value.toFixed(3)))
}

/** Parse what the user typed in `unit` back into stored milliseconds. `undefined` = leave unset. */
export const toMs = (text: string, unitMs: number): number | undefined => {
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * unitMs)
}

export const MINUTE_MS = 60_000
export const SECOND_MS = 1_000
