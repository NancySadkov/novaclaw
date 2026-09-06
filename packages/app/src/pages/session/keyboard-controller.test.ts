import { expect, test } from "bun:test"
import { createSessionKeyboardController } from "./keyboard-controller"

const setup = () => {
  const composer = document.createElement("div")
  composer.tabIndex = 0
  document.body.append(composer)
  const handle = createSessionKeyboardController({
    composer: () => composer,
    childSession: () => false,
    dialogActive: () => false,
    terminalOpen: () => false,
    activeTerminal: () => undefined,
  })
  return { composer, handle }
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

test("explicit page navigation keys retain their native scrolling behavior without focusing the composer", () => {
  const value = setup()
  document.body.focus()
  value.handle(new KeyboardEvent("keydown", { key: "PageDown" }))
  expect(document.activeElement).not.toBe(value.composer)
  value.composer.remove()
})
