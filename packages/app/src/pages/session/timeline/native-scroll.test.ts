import { expect, test } from "bun:test"
import { createBottomPinController, isAtBottom, keyboardUnpins, navigationTargetIndex, nextPinned } from "./native-scroll"

/**
 * A scroll container with geometry the test controls.
 *
 * ⚠️ **Why the geometry is stubbed rather than measured.** This lane (happy-dom) has no layout: every
 * `scrollHeight`/`clientHeight` reads 0, so real geometry can never be exercised here. A real
 * Chromium probe of the shipped transcript (15 scenarios: 12 mount/reconcile shapes plus controls,
 * 2026-09-12) painted ZERO frames with tall content away from the bottom, so the painted-frame
 * property has no failing shape to guard. What CAN be guarded is the controller's seam contract,
 * with the geometry a real browser was observed to produce: a reconcile that empties the row set
 * makes Chromium clamp `scrollTop` to 0 while the content is absent, and the rows then return in a
 * later task.
 */
function fakeScroller(geometry: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const element = document.createElement("div")
  // A real scroller holds `scrollTop` inside [0, scrollHeight - clientHeight]: a write past the end
  // clamps, and so does a content box that shrinks under the current position. `stick()` writes
  // `scrollHeight` (past the end on purpose), so without this clamp the fake would report a position
  // no browser can produce and the assertions below would mean nothing.
  const clamp = () => {
    const max = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
    geometry.scrollTop = Math.min(Math.max(0, geometry.scrollTop), max)
  }
  for (const key of ["scrollHeight", "clientHeight"] as const) {
    Object.defineProperty(element, key, {
      configurable: true,
      get: () => geometry[key],
      set: (value: number) => {
        geometry[key] = value
        clamp()
      },
    })
  }
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => {
      geometry.scrollTop = value
      clamp()
    },
  })
  // ⚠️ Geometry is written through the returned handle, never through the element: `scrollHeight` is
  // read-only on `HTMLElement`, so `scroller.scrollHeight = n` is a type error (caught by typecheck,
  // 2026-09-12). The element's own accessors read the same object, so the controller still sees it.
  return { element, geometry }
}

const nextFrames = async (count: number) => {
  for (let index = 0; index < count; index++) await new Promise((resolve) => requestAnimationFrame(resolve))
}

/**
 * Drain frames until `condition` holds, with a bound.
 *
 * ⚠️ A FIXED frame count is the flake this replaces. The MutationObserver callback is a microtask that
 * then schedules the rAF `stick()`, so under a loaded event loop (a whole `app:unit` run, 237 files)
 * two frames can pass before the observer even runs and the restore lands on the third — green alone,
 * red in the suite (measured 2026-09-16, twice). Waiting on the CONDITION keeps the guard honest: if
 * the observer or its rAF is removed the frame budget runs out and the assertion still fails.
 */
const until = async (condition: () => boolean, frames = 30) => {
  for (let index = 0; index < frames && !condition(); index++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
}

test("a DOM-owned move that leaves the view off the bottom cannot revoke the pin", async () => {
  const { element: scroller, geometry } = fakeScroller({ scrollHeight: 6628, clientHeight: 500, scrollTop: 6128 })
  const content = document.createElement("div")
  let pinned = true
  const controller = createBottomPinController({
    scroller,
    content,
    pinned: () => pinned,
    setPinned: (value) => (pinned = value),
  })
  // Drain the constructor's own rAF `stick()` first, so every correction below can only come from the
  // observer seam this test is about.
  await nextFrames(2)

  // ⚠️ The shape has to leave the view OFF the bottom or the test proves nothing: a clamp while the
  // rows are absent lands exactly at the bottom (scrollHeight === clientHeight), so geometry alone
  // would keep the pin and the assertion below would hold even with the rule reversed — measured
  // 2026-09-12 against a mutated `nextPinned`. Content growing ABOVE the reader (scroll anchoring, a
  // fold expanding) is the move that emits a gestureless `scroll` event while leaving a gap.
  geometry.scrollHeight = 7000
  scroller.dispatchEvent(new Event("scroll"))

  expect(pinned).toBe(true)
  expect(scroller.scrollTop).toBe(6500)
  // The other half of the contract: a wheel toward history IS user intent, and it still unpins.
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }))
  expect(pinned).toBe(false)
  controller.dispose()
})

test("a shrinking viewport cannot leave a pinned view off the bottom", async () => {
  // 🔴 happy-dom fires no ResizeObserver callbacks (there is no layout to observe), so the browser's
  // notification is replayed by hand: record what the controller observes, then deliver the callback
  // the browser would deliver for the box that changed.
  const observed: { target: Element; deliver: () => void }[] = []
  const Original = globalThis.ResizeObserver
  class Recording {
    constructor(private callback: () => void) {}
    observe(target: Element) {
      observed.push({ target, deliver: () => this.callback() })
    }
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Recording

  try {
    const { element: scroller, geometry } = fakeScroller({ scrollHeight: 6628, clientHeight: 500, scrollTop: 6128 })
    const content = document.createElement("div")
    let pinned = true
    const controller = createBottomPinController({
      scroller,
      content,
      pinned: () => pinned,
      setPinned: (value) => (pinned = value),
    })
    await nextFrames(2)
    expect(scroller.scrollTop).toBe(6128)

    // The composer region grows after the switch, so the transcript's viewport shrinks. The content
    // box is unchanged; only the scroller box moved, and its bottom is now 110px further down.
    geometry.clientHeight = 390
    expect(scroller.scrollTop).toBe(6128)

    const notification = observed.find((entry) => entry.target === scroller)
    expect(notification).toBeDefined()
    notification!.deliver()
    expect(scroller.scrollTop).toBe(6238)
    expect(pinned).toBe(true)

    // The other half: the viewport is now a trigger, so it must not drag a reader who has scrolled up
    // back to the bottom.
    pinned = false
    notification!.deliver()
    expect(scroller.scrollTop).toBe(6238)
    controller.dispose()
  } finally {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Original
  }
})

test("the view is back at the bottom once the rows return", async () => {
  const { element: scroller, geometry } = fakeScroller({ scrollHeight: 6628, clientHeight: 500, scrollTop: 6128 })
  const content = document.createElement("div")
  let pinned = true
  const controller = createBottomPinController({
    scroller,
    content,
    pinned: () => pinned,
    setPinned: (value) => (pinned = value),
  })
  // ⚠️ Draining this frame is what makes the test about the OBSERVER. Left pending, the constructor's
  // own rAF `stick()` fires after the rows are back and restores the bottom by itself — the test then
  // passes with the MutationObserver removed (measured: mutation A, 2026-09-12).
  await nextFrames(2)
  expect(scroller.scrollTop).toBe(6128)

  // Collapse and restore the rows exactly as a reconcile does, one task apart.
  content.appendChild(document.createElement("div"))
  // The content box shrinks under the reader: the fake clamps the position to 0 during that "layout",
  // exactly as Chromium does, and the gestureless `scroll` event follows.
  geometry.scrollHeight = 500
  scroller.dispatchEvent(new Event("scroll"))
  geometry.scrollHeight = 6628
  content.appendChild(document.createElement("div"))

  // ⚠️ The stale position is still 0 here — the restore is the MutationObserver's deferred rAF
  // `stick()`. Asserting both sides is what makes this fail if that rAF (or the observer feeding it)
  // is removed: the controller would leave the reader at the top of the chat.
  expect(scroller.scrollTop).toBe(0)
  await until(() => scroller.scrollTop === 6128)
  expect(scroller.scrollTop).toBe(6128)
  controller.dispose()
})

test("reattaching the session subtree cannot reset a pinned timeline to the top", async () => {
  const { element: scroller, geometry } = fakeScroller({ scrollHeight: 6628, clientHeight: 500, scrollTop: 6128 })
  const content = document.createElement("div")
  const route = document.createElement("div")
  const main = document.createElement("main")
  scroller.append(content)
  route.append(scroller)
  main.append(route)
  document.body.append(main)
  let pinned = true
  const controller = createBottomPinController({
    scroller,
    content,
    pinned: () => pinned,
    setPinned: (value) => (pinned = value),
  })
  await nextFrames(2)

  // This is Solid Suspense's resolved-subtree swap. happy-dom has no native layout, so replay
  // Chromium's measured silent reset between removing and reinserting the SAME nodes.
  route.remove()
  geometry.scrollTop = 0
  main.append(route)
  expect(scroller.scrollTop).toBe(0)
  await nextFrames(1)
  expect(scroller.scrollTop).toBe(6128)

  controller.dispose()
  main.remove()
})

test("isAtBottom is true at the exact bottom", () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 600 })).toBe(true)
})

test("isAtBottom is true within the threshold", () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 340, clientHeight: 600 }, 80)).toBe(true) // 60px from bottom
})

test("isAtBottom is false past the threshold", () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 600 }, 80)).toBe(false) // 200px from bottom
})

test("nextPinned pins when scrolled to the bottom", () => {
  expect(nextPinned(false, { scrollHeight: 1000, scrollTop: 400, clientHeight: 600 })).toBe(true)
})

test("a near-bottom move toward history cannot undo explicit user unpinning", () => {
  expect(nextPinned(false, { scrollHeight: 1000, scrollTop: 360, clientHeight: 600 })).toBe(false)
  expect(nextPinned(false, { scrollHeight: 1000, scrollTop: 360, clientHeight: 600 })).toBe(false)
})

test("a delayed browser viewport move cannot revoke user intent", () => {
  expect(nextPinned(true, { scrollHeight: 1000, scrollTop: 399, clientHeight: 600 })).toBe(true)
  expect(nextPinned(true, { scrollHeight: 1000, scrollTop: 0, clientHeight: 600 })).toBe(true)
})

test("geometry alone cannot impersonate a scrollbar gesture", () => {
  expect(nextPinned(true, { scrollHeight: 1000, scrollTop: 200, clientHeight: 600 })).toBe(true)
})

test("nextPinned keeps the current pin on a zero-height (headless) layout", () => {
  // scrollHeight huge, clientHeight 0 → isAtBottom would say false, but we must not unpin.
  expect(nextPinned(true, { scrollHeight: 166332, scrollTop: 0, clientHeight: 0 })).toBe(true)
  expect(nextPinned(false, { scrollHeight: 166332, scrollTop: 0, clientHeight: 0 })).toBe(false)
})

test("only history-directed keys explicitly unpin", () => {
  expect(keyboardUnpins("ArrowUp")).toBe(true)
  expect(keyboardUnpins("PageUp")).toBe(true)
  expect(keyboardUnpins("Home")).toBe(true)
  expect(keyboardUnpins("ArrowDown")).toBe(false)
  expect(keyboardUnpins("End")).toBe(false)
})

test("message navigation treats the position after the final row as the latest boundary", () => {
  expect(navigationTargetIndex(3, 3, -1)).toBe(2)
  expect(navigationTargetIndex(2, 3, 1)).toBe(3)
  expect(navigationTargetIndex(0, 3, -1)).toBeUndefined()
})
