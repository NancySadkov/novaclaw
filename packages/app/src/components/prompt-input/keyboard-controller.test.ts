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
    state: { mode: () => mode, historyIndex: () => -1 },
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
    pickAttachment: () => {},
    abort: () => {},
    blurOnEscape: () => false,
    addNewline: () => {
      newline++
    },
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

test("one Escape stops working", () => {
  const element = document.createElement("div")
  document.body.append(element)
  let stops = 0
  const handle = createPromptInputKeyboardController({
    state: { mode: () => "normal", historyIndex: () => -1 },
    editor: {
      element: () => element,
      collapseBackspaceAtZeroWidth: () => {},
      blur: () => {},
      caret: () => ({ collapsed: true, cursorPosition: 0, textLength: 0 }),
    },
    advanced: () => true,
    composing: () => false,
    working: () => true,
    promptText: () => "",
    attachmentCount: () => 0,
    commentCount: () => 0,
    setMode: () => {},
    pickAttachment: () => {},
    abort: () => stops++,
    blurOnEscape: () => false,
    addNewline: () => {},
    navigateHistory: () => false,
    submit: () => {},
  })
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true })
  handle(event)
  expect(stops).toBe(1)
  expect(event.defaultPrevented).toBe(true)
  element.remove()
})
