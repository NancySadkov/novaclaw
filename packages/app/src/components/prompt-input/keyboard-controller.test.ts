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

test("Enter with an empty composer while working still submits — the empty submit IS the stop", () => {
  const element = document.createElement("div")
  document.body.append(element)
  let submits = 0
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
    abort: () => {},
    blurOnEscape: () => false,
    addNewline: () => {},
    navigateHistory: () => false,
    submit: () => {
      submits++
    },
  })
  // 🔴 Swallowing this Enter made it the one key that did nothing while the button stopped and
  // Esc stopped (owner, 2026-09-26). handleSubmit aborts on blank+working, so reaching submit
  // is what makes Enter stop too.
  const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true })
  handle(event)
  expect(submits).toBe(1)
  expect(event.defaultPrevented).toBe(true)
  element.remove()
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
