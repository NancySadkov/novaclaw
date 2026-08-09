import { expect, test } from "bun:test"
import { createPromptInputKeyboardController } from "./keyboard-controller"

const setup = (advanced = true) => {
  const element = document.createElement("div")
  element.contentEditable = "true"
  document.body.append(element)
  let mode: "normal" | "shell" = "normal"
  let newline = 0
  let submit = 0
  const handle = createPromptInputKeyboardController({
    state: { mode: () => mode, popover: () => null, historyIndex: () => -1 },
    editor: {
      element: () => element,
      collapseBackspaceAtZeroWidth: () => {},
      blur: () => {},
      caret: () => ({ collapsed: true, cursorPosition: 0, textLength: 0 }),
    },
    advanced: () => advanced,
    composing: () => false,
    working: () => false,
    promptText: () => "",
    attachmentCount: () => 0,
    commentCount: () => 0,
    setMode: (value) => {
      mode = value
    },
    closePopover: () => {},
    pickAttachment: () => {},
    abort: () => {},
    blurOnEscape: () => false,
    addNewline: () => {
      newline++
    },
    selectPopoverActive: () => {},
    atKeyDown: () => {},
    slashKeyDown: () => {},
    scrollSlashActiveIntoView: () => {},
    navigateHistory: () => false,
    submit: () => {
      submit++
    },
  })
  return { element, handle, mode: () => mode, newline: () => newline, submit: () => submit }
}

test("an advanced user's leading exclamation enters shell mode without inserting text", () => {
  const value = setup()
  const event = new KeyboardEvent("keydown", { key: "!", cancelable: true })
  value.handle(event)
  expect(value.mode()).toBe("shell")
  expect(event.defaultPrevented).toBe(true)
  value.element.remove()
})

test("a normal user's leading exclamation remains ordinary text input", () => {
  const value = setup(false)
  const event = new KeyboardEvent("keydown", { key: "!", cancelable: true })
  value.handle(event)
  expect(value.mode()).toBe("normal")
  expect(event.defaultPrevented).toBe(false)
  value.element.remove()
})

test("Shift+Enter inserts a newline before IME and submit handling", () => {
  const value = setup()
  const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true })
  value.handle(event)
  expect(value.newline()).toBe(1)
  expect(value.submit()).toBe(0)
  expect(event.defaultPrevented).toBe(true)
  value.element.remove()
})
