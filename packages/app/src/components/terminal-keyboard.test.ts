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

  test("find opens on the standard Ctrl/Cmd+Shift+F", () => {
    expect(terminalWorkspaceShortcut(key("f", { ctrlKey: true, shiftKey: true }))).toBe("find")
    expect(terminalWorkspaceShortcut(key("F", { metaKey: true, shiftKey: true }))).toBe("find")
    // Plain Ctrl+F must NOT be taken: it is a live control character in a shell (forward-char in
    // readline, and page-forward in less/vim), so stealing it would break editing inside the terminal
    // to serve a UI that has its own modifier.
    expect(terminalWorkspaceShortcut(key("f", { ctrlKey: true }))).toBeUndefined()
  })

  test("Shift turns tab NAVIGATION into tab REORDER, on the browser convention", () => {
    expect(terminalWorkspaceShortcut(key("PageDown", { ctrlKey: true, shiftKey: true }))).toBe("move-next")
    expect(terminalWorkspaceShortcut(key("PageUp", { metaKey: true, shiftKey: true }))).toBe("move-previous")
  })

  test("reorder does not swallow plain navigation, and neither shadows the other", () => {
    // The negative control for the pair above: these four live one Shift apart, so an ordering
    // mistake in the parser would silently turn "next tab" into "move tab" — a keystroke people
    // press constantly quietly rearranging their workspace.
    expect(terminalWorkspaceShortcut(key("PageDown", { ctrlKey: true }))).toBe("next")
    expect(terminalWorkspaceShortcut(key("PageUp", { ctrlKey: true }))).toBe("previous")
    // Reorder exists so the drag gesture is not the only way; it must stay keyboard-reachable.
    expect(terminalWorkspaceShortcut(key("PageDown", { ctrlKey: true, shiftKey: true, altKey: true }))).toBeUndefined()
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
