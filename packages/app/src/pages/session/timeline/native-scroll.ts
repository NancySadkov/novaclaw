/**
 * Pure geometry helpers for the native timeline's chat auto-scroll (F1e THE FLIP, F-a).
 *
 * Kept free of DOM/solid wiring so the pin/unpin decision is unit-testable — the flaky
 * headless preview can't reliably exercise real scroll geometry (its viewport is 0×0
 * until resized), so the decision logic is covered here and the timeline only does the
 * element plumbing.
 */

export interface ScrollMetrics {
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly clientHeight: number
}

/** Whether the viewport is scrolled to within `threshold`px of the bottom. */
export function isAtBottom(m: ScrollMetrics, threshold = 80): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold
}

/**
 * The next `pinned` state after a scroll event. A zero-height container (a headless or
 * hidden layout) reports bogus geometry, so keep the current pin rather than falsely
 * unpinning — otherwise a 0×0 mount permanently unsticks the chat.
 */
export function nextPinned(current: boolean, m: ScrollMetrics, threshold = 80): boolean {
  if (m.clientHeight === 0) return current
  return isAtBottom(m, threshold)
}
