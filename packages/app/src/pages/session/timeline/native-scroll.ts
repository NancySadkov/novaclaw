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

/** Whether the viewport is scrolled to within `tolerance`px of the bottom. */
export function isAtBottom(m: ScrollMetrics, tolerance = 1): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= tolerance
}

/**
 * The next `pinned` state after a scroll event. A pin is USER INTENT, not geometry: browser scroll
 * anchoring, a fold collapsing, history reconciliation, and a route remount can all move
 * `scrollTop` and emit the same event as a wheel — sometimes several frames after the DOM mutation.
 * Therefore geometry may NEVER revoke an existing pin. Revocation belongs only to the
 * wheel/touch/key/scrollbar handlers in the controller below; those are the seams that actually
 * establish user intent. Once user intent has unpinned the view, proximity may not overwrite it:
 * the reader re-pins only on actually reaching the bottom (with one pixel of tolerance for
 * fractional layout geometry).
 */
export function nextPinned(current: boolean, m: ScrollMetrics): boolean {
  if (m.clientHeight === 0) return current
  if (current) return true
  return isAtBottom(m)
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
  let layoutFrame: number | undefined
  const stick = () => {
    if (!input.pinned()) return
    input.scroller.scrollTop = input.scroller.scrollHeight
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
  const onKeyDown = (event: KeyboardEvent) => {
    if (keyboardUnpins(event.key)) input.setPinned(false)
  }
  // Pointer events on the scrollbar target the scroll container itself; content clicks target a
  // descendant. This gives native scrollbar dragging an explicit intent seam without treating a
  // later browser-generated scroll event as proof that the user moved it.
  const onPointerDown = (event: PointerEvent) => {
    if (event.target === input.scroller) input.setPinned(false)
  }

  input.scroller.addEventListener("scroll", onScroll)
  input.scroller.addEventListener("wheel", onWheel)
  input.scroller.addEventListener("touchstart", onTouchStart)
  input.scroller.addEventListener("touchmove", onTouchMove)
  input.scroller.addEventListener("touchend", onTouchEnd)
  input.scroller.addEventListener("keydown", onKeyDown)
  input.scroller.addEventListener("pointerdown", onPointerDown)
  const resizeObserver = new ResizeObserver(stick)
  resizeObserver.observe(input.content)
  // A history reconcile can replace DOM rows with equal-height rows in one rendering turn. The
  // content's final border box is unchanged, so ResizeObserver has nothing to report, but Chromium
  // may already have clamped scrollTop while the old rows were absent. MutationObserver is the only
  // seam that sees that layout transaction before its deferred `scroll` event arrives.
  const mutationObserver = new MutationObserver(() => {
    if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame)
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = undefined
      stick()
    })
  })
  mutationObserver.observe(input.content, { childList: true, subtree: true, characterData: true, attributes: true })
  stick()
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = undefined
    stick()
  })

  return {
    stick,
    scrollToBottom,
    dispose() {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame)
      input.scroller.removeEventListener("scroll", onScroll)
      input.scroller.removeEventListener("wheel", onWheel)
      input.scroller.removeEventListener("touchstart", onTouchStart)
      input.scroller.removeEventListener("touchmove", onTouchMove)
      input.scroller.removeEventListener("touchend", onTouchEnd)
      input.scroller.removeEventListener("keydown", onKeyDown)
      input.scroller.removeEventListener("pointerdown", onPointerDown)
    },
  }
}

export function navigationTargetIndex(current: number, count: number, offset: number): number | undefined {
  const target = current + offset
  if (target < 0 || target > count) return
  return target
}
