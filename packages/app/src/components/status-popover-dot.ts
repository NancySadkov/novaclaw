/**
 * The titlebar health dot's whole decision, pure — so the interesting combinations are assertable
 * without a DOM. It lives beside `status-popover.tsx` rather than inside it because that file pulls
 * in Kobalte, which cannot be loaded outside a browser; a decision nobody can unit-test is a
 * decision that fails silently, and this one did.
 */

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
export type StatusDotTone = "healthy" | "warning" | "unreachable" | "unknown"

/**
 * One tone, one class. The values are asserted distinct in the tests — two tones sharing a class
 * would be two states a person cannot tell apart, which is the same defect wearing different
 * clothes.
 */
export const STATUS_DOT_CLASS: Record<StatusDotTone, string> = {
  healthy: "bg-icon-success-base",
  warning: "bg-icon-warning-base",
  unreachable: "bg-icon-critical-base",
  unknown: "bg-border-weak-base",
}

/**
 * `serverHealth` is deliberately tri-state (`true` / `false` / not yet known) and each value means
 * something different to the person looking at the strip: it is up, it is down, or we have not
 * heard yet. `ready` is the second half of "we have not heard yet" — the MCP picture has not
 * loaded — and only ever softens the answer, never hardens it. A KNOWN-down server is reported as
 * down whatever else has or has not loaded.
 */
export function statusDotTone(input: {
  readonly serverHealth: boolean | undefined
  /** Enough is known to say something more specific than "unknown". */
  readonly ready: boolean
  readonly issue?: "critical" | "warning"
}): StatusDotTone {
  if (input.serverHealth === false) return "unreachable"
  if (input.serverHealth === undefined || !input.ready) return "unknown"
  if (input.issue === "critical") return "unreachable"
  if (input.issue === "warning") return "warning"
  return "healthy"
}
