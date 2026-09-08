import { describe, expect, test } from "bun:test"
import {
  canOpenTabRename,
  canStartTabDrag,
  forwardTabRef,
  revealTabInStrip,
  TAB_DRAG_ACTIVATION_DISTANCE,
} from "./titlebar-tab-gesture"

describe("titlebar tab gestures", () => {
  test("forwards component refs", () => {
    const element = document.createElement("div")
    let received: HTMLDivElement | undefined
    forwardTabRef((value) => (received = value), element)
    expect(received).toBe(element)
  })

  test("does not reopen rename while a save is pending", () => {
    expect(canOpenTabRename(false, false, false)).toBe(true)
    expect(canOpenTabRename(false, false, true)).toBe(false)
  })

  test("preserves native panning for touch pointers", () => {
    expect(canStartTabDrag("mouse")).toBe(true)
    expect(canStartTabDrag("pen")).toBe(true)
    expect(canStartTabDrag("touch")).toBe(false)
  })

  test("requires deliberate pointer travel before a click becomes a drag", () => {
    expect(TAB_DRAG_ACTIVATION_DISTANCE).toBeGreaterThanOrEqual(8)
  })

  test("leaves an already visible tab and every ancestor scroll position still", () => {
    const strip = document.createElement("div")
    strip.dataset.slot = "titlebar-tabs-scroll"
    const tab = document.createElement("div")
    strip.append(tab)
    strip.scrollLeft = 40
    Object.defineProperty(strip, "getBoundingClientRect", { value: () => ({ left: 10, right: 210 }) })
    Object.defineProperty(tab, "getBoundingClientRect", { value: () => ({ left: 50, right: 150 }) })

    revealTabInStrip(tab)

    expect(strip.scrollLeft).toBe(40)
  })

  test("reveals only the clipped horizontal edge inside the tab strip", () => {
    const strip = document.createElement("div")
    strip.dataset.slot = "titlebar-tabs-scroll"
    const tab = document.createElement("div")
    strip.append(tab)
    strip.scrollLeft = 40
    Object.defineProperty(strip, "getBoundingClientRect", { value: () => ({ left: 10, right: 210 }) })
    Object.defineProperty(tab, "getBoundingClientRect", { value: () => ({ left: 180, right: 230 }) })

    revealTabInStrip(tab)

    expect(strip.scrollLeft).toBe(60)
  })
})
