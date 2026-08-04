import { describe, expect, test } from "bun:test"
import { restartTerminalCursorBlink, terminalClipboardShortcut, terminalWorkspaceShortcut } from "./terminal-keyboard"

const key = (
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
) => ({ key: value, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers })

describe("terminal keyboard", () => {
  test("recognizes standard copy and paste shortcuts without stealing Ctrl+C", () => {
    expect(terminalClipboardShortcut(key("c", { ctrlKey: true, shiftKey: true }))).toBe("copy")
    expect(terminalClipboardShortcut(key("Insert", { ctrlKey: true }))).toBe("copy")
    expect(terminalClipboardShortcut(key("v", { ctrlKey: true, shiftKey: true }))).toBe("paste")
    expect(terminalClipboardShortcut(key("Insert", { shiftKey: true }))).toBe("paste")
    expect(terminalClipboardShortcut(key("c", { ctrlKey: true }))).toBeUndefined()
  })

  test("recognizes terminal tab shortcuts on Ctrl and Command", () => {
    expect(terminalWorkspaceShortcut(key("t", { ctrlKey: true, shiftKey: true }))).toBe("new")
    expect(terminalWorkspaceShortcut(key("w", { metaKey: true, shiftKey: true }))).toBe("close")
    expect(terminalWorkspaceShortcut(key("PageDown", { ctrlKey: true }))).toBe("next")
    expect(terminalWorkspaceShortcut(key("PageUp", { metaKey: true }))).toBe("previous")
  })

  test("reveals the cursor before restarting its blink interval", () => {
    const writes: boolean[] = []
    const options = {
      get cursorBlink() {
        return writes.at(-1) ?? true
      },
      set cursorBlink(value: boolean) {
        writes.push(value)
      },
    }
    restartTerminalCursorBlink(options)
    expect(writes).toEqual([false, true])
  })
})
