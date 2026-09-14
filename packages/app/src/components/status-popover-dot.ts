/** The server-row health dot's whole decision, pure and unit-testable without a DOM. */

/**
 * What the health dot is SAYING. Exactly one of these, always.
 *
 * 🔴 This used to be four independent booleans in a `classList`, one per background class, and that
 * shape has two failure modes that look nothing alike and are both silent. Overlap: several
 * predicates true at once, so the dot's colour is whichever class the cascade happens to win with —
 * and a `.tsx`-imported stylesheet is UNLAYERED, so that is not decidable by reading the JSX.
 * Underlap: no predicate true, so the dot renders with no background at all — transparent, at the
 * exact moment it exists for. Both shipped at once: an edit folded `serverHealth === false` and
 * `serverHealth === undefined` into a single "the server is up" test, and a healthy instance got
 * three backgrounds while an unreachable one got none.
 *
 * A total function returning ONE tone removes both by construction: there is no combination of
 * inputs that yields two answers, and none that yields no answer.
 */
export type StatusDotTone = "healthy" | "unreachable" | "unknown"

/**
 * One tone, one class. The values are asserted distinct in the tests — two tones sharing a class
 * would be two states a person cannot tell apart, which is the same defect wearing different
 * clothes.
 */
export const STATUS_DOT_CLASS: Record<StatusDotTone, string> = {
  healthy: "bg-icon-success-base",
  unreachable: "bg-icon-critical-base",
  unknown: "bg-border-weak-base",
}

/**
 * `serverHealth` is deliberately tri-state (`true` / `false` / not yet known) and each value means
 * something different to the person looking at the server row: it is up, it is down, or we have
 * not heard yet.
 */
export function statusDotTone(input: { readonly serverHealth: boolean | undefined }): StatusDotTone {
  if (input.serverHealth === false) return "unreachable"
  if (input.serverHealth === undefined) return "unknown"
  return "healthy"
}
