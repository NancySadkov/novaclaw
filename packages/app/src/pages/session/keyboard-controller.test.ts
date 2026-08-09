import { expect, test } from "bun:test"
import { createSessionKeyboardController } from "./keyboard-controller"

const setup = () => {
  const composer = document.createElement("div")
  composer.tabIndex = 0
  document.body.append(composer)
  let scrollGestures = 0
  const handle = createSessionKeyboardController({
    composer: () => composer,
    composerBlocked: () => false,
    childSession: () => false,
    dialogActive: () => false,
    terminalOpen: () => false,
    activeTerminal: () => undefined,
    markScrollGesture: () => scrollGestures++,
  })
  return { composer, handle, scrollGestures: () => scrollGestures }
}

test("a printable key focuses the composer when no protected surface owns focus", () => {
  const value = setup()
  document.body.focus()
  value.handle(new KeyboardEvent("keydown", { key: "a" }))
  expect(document.activeElement).toBe(value.composer)
  value.composer.remove()
})

test("an editable control keeps focus instead of leaking the key into the composer", () => {
  const value = setup()
  const button = document.createElement("button")
  document.body.append(button)
  button.focus()
  value.handle(new KeyboardEvent("keydown", { key: "a" }))
  expect(document.activeElement).toBe(button)
  button.remove()
  value.composer.remove()
})

test("explicit page navigation keys mark a scroll gesture without focusing the composer", () => {
  const value = setup()
  document.body.focus()
  value.handle(new KeyboardEvent("keydown", { key: "PageDown" }))
  expect(value.scrollGestures()).toBe(1)
  expect(document.activeElement).not.toBe(value.composer)
  value.composer.remove()
})
