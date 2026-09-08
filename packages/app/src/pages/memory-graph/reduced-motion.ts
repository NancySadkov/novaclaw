/**
 * `prefers-reduced-motion`, WATCHED rather than sampled.
 *
 * 🔴 A one-time read at mount is the failure this module exists to prevent. The preference is a
 * system setting a person can change while the app is open — that is in fact WHEN they change it,
 * because they change it in response to something moving — and a page that read it once keeps
 * flaring at somebody who has just asked it to stop. The Memory app is a long-lived surface: it can
 * sit open for a whole session, so "we read it at startup" means "we will be wrong for hours".
 *
 * ⚠️ Split out of `activity-live.ts` so the RULE is testable without a Solid root, a DOM, or a real
 * media query. The subject here is a listener's lifecycle, and a listener that is never asked to
 * deliver a second value is indistinguishable from a variable.
 */

/** The parts of `MediaQueryList` this needs — including the pre-2021 `addListener` shape. */
export interface MediaQueryLike {
  readonly matches: boolean
  addEventListener?: (type: "change", listener: (event: { matches: boolean }) => void) => void
  removeEventListener?: (type: "change", listener: (event: { matches: boolean }) => void) => void
  addListener?: (listener: (event: { matches: boolean }) => void) => void
  removeListener?: (listener: (event: { matches: boolean }) => void) => void
}

/**
 * Push the query's current value, then every change, until the returned function is called.
 *
 * ⚠️ **The initial push happens even when nothing can be subscribed to.** An environment with no
 * `matchMedia` (a test, a server render) or a query object that supports no listener API still gets
 * the truth once — degrading to "we cannot hear about changes" is very different from degrading to
 * "we never found out at all".
 */
export function watchMedia(query: MediaQueryLike | undefined, onChange: (matches: boolean) => void): () => void {
  if (!query) {
    onChange(false)
    return () => {}
  }
  onChange(query.matches)
  const listener = (event: { matches: boolean }) => onChange(event.matches)
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener)
    return () => query.removeEventListener?.("change", listener)
  }
  if (typeof query.addListener === "function") {
    query.addListener(listener)
    return () => query.removeListener?.(listener)
  }
  return () => {}
}

/** The one query this app asks about motion. Named so no surface can spell it differently. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

export const reducedMotionQuery = (): MediaQueryLike | undefined => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY)
  } catch {
    return undefined
  }
}
