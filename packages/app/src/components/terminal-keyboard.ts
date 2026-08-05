type ShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">

export type TerminalClipboardShortcut = "copy" | "paste"
export type TerminalWorkspaceShortcut =
  | "new"
  | "close"
  | "next"
  | "previous"
  | "move-next"
  | "move-previous"
  | "find"

export function terminalClipboardShortcut(event: ShortcutEvent): TerminalClipboardShortcut | undefined {
  const key = event.key.toLowerCase()
  if (event.altKey || event.metaKey) return
  if (event.ctrlKey && event.shiftKey && key === "c") return "copy"
  if (event.ctrlKey && !event.shiftKey && key === "insert") return "copy"
  if (event.ctrlKey && event.shiftKey && key === "v") return "paste"
  if (!event.ctrlKey && event.shiftKey && key === "insert") return "paste"
}

export function terminalWorkspaceShortcut(event: ShortcutEvent): TerminalWorkspaceShortcut | undefined {
  if (event.altKey) return
  const modifier = event.ctrlKey || event.metaKey
  if (!modifier) return
  const key = event.key.toLowerCase()
  if (event.shiftKey && key === "f") return "find"
  if (event.shiftKey && key === "t") return "new"
  if (event.shiftKey && key === "w") return "close"
  if (!event.shiftKey && key === "pagedown") return "next"
  if (!event.shiftKey && key === "pageup") return "previous"
  // Reorder, on the same convention browsers use: Shift turns "go to the next tab" into "take this
  // tab with you". It exists because the other way to reorder is DRAG, and a drag-only affordance is
  // unreachable by keyboard — which on a surface gated to Advanced/Developer would quietly mean the
  // people most likely to live in this app are the ones who cannot use half of it.
  if (event.shiftKey && key === "pagedown") return "move-next"
  if (event.shiftKey && key === "pageup") return "move-previous"
}

/** Keyboard input should reveal the cursor immediately, then begin a fresh blink interval. */
export function restartTerminalCursorBlink(options: { cursorBlink: boolean }) {
  options.cursorBlink = false
  options.cursorBlink = true
}
