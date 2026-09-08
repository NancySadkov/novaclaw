import { expect, test } from "bun:test"
import { isAtBottom, keyboardUnpins, navigationTargetIndex, nextPinned } from "./native-scroll"

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
