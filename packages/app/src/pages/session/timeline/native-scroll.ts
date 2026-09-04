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
 * as a wheel. Therefore geometry may re-pin an unpinned view at the bottom, but may never revoke an
 * existing pin. Explicit wheel/touch/scrollbar/keyboard handlers revoke it before their scroll.
 */
export function nextPinned(current: boolean, m: ScrollMetrics, threshold = 80): boolean {
  if (current || m.clientHeight === 0) return current
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
  const stick = () => {
    if (input.pinned()) input.scroller.scrollTop = input.scroller.scrollHeight
  }
  const scrollToBottom = () => {
    input.setPinned(true)
    stick()
  }
  const onScroll = () => {
    const next = nextPinned(input.pinned(), input.scroller)
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
  const onPointerDown = (event: PointerEvent) => {
    const rect = input.scroller.getBoundingClientRect()
    if (rect.right - event.clientX <= 20) input.setPinned(false)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (keyboardUnpins(event.key)) input.setPinned(false)
  }

  input.scroller.addEventListener("scroll", onScroll)
  input.scroller.addEventListener("wheel", onWheel)
  input.scroller.addEventListener("touchstart", onTouchStart)
  input.scroller.addEventListener("touchmove", onTouchMove)
  input.scroller.addEventListener("touchend", onTouchEnd)
  input.scroller.addEventListener("pointerdown", onPointerDown)
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
      input.scroller.removeEventListener("pointerdown", onPointerDown)
      input.scroller.removeEventListener("keydown", onKeyDown)
    },
  }
}

export function navigationTargetIndex(current: number, count: number, offset: number): number | undefined {
  const target = current + offset
  if (target < 0 || target > count) return
  return target
}
