import { expect, test } from "bun:test"
import { isTitlebarContextMenu } from "./titlebar-context-menu"

test("desktop titlebar context menus stay out of the home and tab region", () => {
  expect(isTitlebarContextMenu(10, 1200, 800, 1)).toBe(true)
  expect(isTitlebarContextMenu(35, 1200, 800, 1)).toBe(true)
  expect(isTitlebarContextMenu(36, 1200, 800, 1)).toBe(false)
  expect(isTitlebarContextMenu(70, 2400, 800, 2)).toBe(true)
  expect(isTitlebarContextMenu(72, 2400, 800, 2)).toBe(false)
})

test("compact titlebars can be moved to the bottom", () => {
  expect(isTitlebarContextMenu(760, 700, 800, 1)).toBe(true)
  expect(isTitlebarContextMenu(755, 700, 800, 1)).toBe(false)
  expect(isTitlebarContextMenu(300, 700, 800, 1)).toBe(false)
})
