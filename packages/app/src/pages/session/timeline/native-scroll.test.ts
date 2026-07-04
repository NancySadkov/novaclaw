import { expect, test } from "bun:test"
import { isAtBottom, nextPinned } from "./native-scroll"

test("isAtBottom is true at the exact bottom", () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 600 })).toBe(true)
})

test("isAtBottom is true within the threshold", () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 340, clientHeight: 600 })).toBe(true) // 60px from bottom
})

test("isAtBottom is false past the threshold", () => {
  expect(isAtBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 600 })).toBe(false) // 200px from bottom
})

test("nextPinned pins when scrolled to the bottom", () => {
  expect(nextPinned(false, { scrollHeight: 1000, scrollTop: 400, clientHeight: 600 })).toBe(true)
})

test("nextPinned unpins when the user scrolls up", () => {
  expect(nextPinned(true, { scrollHeight: 1000, scrollTop: 0, clientHeight: 600 })).toBe(false)
})

test("nextPinned keeps the current pin on a zero-height (headless) layout", () => {
  // scrollHeight huge, clientHeight 0 → isAtBottom would say false, but we must not unpin.
  expect(nextPinned(true, { scrollHeight: 166332, scrollTop: 0, clientHeight: 0 })).toBe(true)
  expect(nextPinned(false, { scrollHeight: 166332, scrollTop: 0, clientHeight: 0 })).toBe(false)
})
