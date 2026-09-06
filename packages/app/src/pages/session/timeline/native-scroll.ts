/**
 * Pure geometry helpers for the native timeline's chat auto-scroll (F1e THE FLIP, F-a).
 *
 * The decisions stay free of Solid, and the DOM controller below owns the event/observer seam so
 * the same code can be exercised against real Chromium geometry.
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
 * The next `pinned` state after a scroll event. A pin is USER INTENT, not geometry: browser scroll
 * anchoring, a fold collapsing, or a route remount can all move `scrollTop` and emit the same event
 * as a wheel. Layout movement at the bottom remains at the exact bottom, while native scrollbar
 * chrome exposes no dependable pointer event to the DOM and is observable only as an upward
 * `scrollTop` transition. That transition revokes the pin as soon as it leaves the exact bottom.
 * An unpinned reader re-pins on returning near the bottom.
 */
export function nextPinned(current: boolean, m: ScrollMetrics, movedTowardHistory = false, threshold = 80): boolean {
  if (m.clientHeight === 0) return current
  if (current) return !movedTowardHistory || isAtBottom(m, 1)
  return isAtBottom(m, threshold)
}

const HISTORY_KEYS = new Set(["ArrowUp", "PageUp", "Home"])

/** Whether a keyboard action explicitly asks to leave the latest message. */
export function keyboardUnpins(key: string): boolean {
  return HISTORY_KEYS.has(key)
}

/**
 * The DOM owner of the bottom-pin invariant. Keeping the listeners and ResizeObserver in one
 * controller means a real-browser test can exercise the exact seam NativeTimeline uses without
 * booting an instance or re-implementing its event rules in the test.
 */
export function createBottomPinController(input: {
  scroller: HTMLElement
  content: HTMLElement
  pinned: () => boolean
  setPinned: (value: boolean) => void
}) {
  let touchY: number | undefined
  let lastScrollTop = input.scroller.scrollTop
  const stick = () => {
    if (!input.pinned()) return
    input.scroller.scrollTop = input.scroller.scrollHeight
    // A controller-owned write emits `scroll` later. Advance the baseline now so that event cannot
    // be mistaken for a scrollbar gesture.
    lastScrollTop = input.scroller.scrollTop
  }
  const scrollToBottom = () => {
    input.setPinned(true)
    stick()
  }
  const onScroll = () => {
    const top = input.scroller.scrollTop
    const next = nextPinned(input.pinned(), input.scroller, top < lastScrollTop - 1)
    lastScrollTop = top
    input.setPinned(next)
    if (next) stick()
  }
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) input.setPinned(false)
  }
  const onTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY
  }
  const onTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY
    if (y !== undefined && touchY !== undefined && y > touchY) input.setPinned(false)
    touchY = y
  }
  const onTouchEnd = () => {
    touchY = undefined
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (keyboardUnpins(event.key)) input.setPinned(false)
  }

  input.scroller.addEventListener("scroll", onScroll)
  input.scroller.addEventListener("wheel", onWheel)
  input.scroller.addEventListener("touchstart", onTouchStart)
  input.scroller.addEventListener("touchmove", onTouchMove)
  input.scroller.addEventListener("touchend", onTouchEnd)
  input.scroller.addEventListener("keydown", onKeyDown)
  const observer = new ResizeObserver(stick)
  observer.observe(input.content)
  stick()
  requestAnimationFrame(stick)

  return {
    stick,
    scrollToBottom,
    dispose() {
      observer.disconnect()
      input.scroller.removeEventListener("scroll", onScroll)
      input.scroller.removeEventListener("wheel", onWheel)
      input.scroller.removeEventListener("touchstart", onTouchStart)
      input.scroller.removeEventListener("touchmove", onTouchMove)
      input.scroller.removeEventListener("touchend", onTouchEnd)
      input.scroller.removeEventListener("keydown", onKeyDown)
    },
  }
}

export function navigationTargetIndex(current: number, count: number, offset: number): number | undefined {
  const target = current + offset
  if (target < 0 || target > count) return
  return target
}
