import { getCursorPosition } from "./editor-dom"
import { canNavigateHistoryAtCursor } from "./history"

type Input = {
  state: {
    mode: () => "normal" | "shell"
    popover: () => "at" | "slash" | null
    historyIndex: () => number
  }
  editor: {
    element: () => HTMLDivElement
    collapseBackspaceAtZeroWidth: () => void
    blur: () => void
    caret: () => { collapsed: boolean; cursorPosition: number; textLength: number }
  }
  advanced: () => boolean
  composing: (event: KeyboardEvent) => boolean
  working: () => boolean
  promptText: () => string
  attachmentCount: () => number
  commentCount: () => number
  setMode: (mode: "normal" | "shell") => void
  closePopover: () => void
  pickAttachment: () => void
  abort: () => unknown
  blurOnEscape: () => boolean
  addNewline: () => void
  selectPopoverActive: () => void
  atKeyDown: (event: KeyboardEvent) => void
  slashKeyDown: (event: KeyboardEvent) => void
  scrollSlashActiveIntoView: () => void
  navigateHistory: (direction: "up" | "down") => boolean
  submit: (event: KeyboardEvent) => Promise<void> | void
}

/** Central keyboard policy for the composer; rendering and command implementations stay outside. */
export function createPromptInputKeyboardController(input: Input) {
  return (event: KeyboardEvent) => {
    const mode = input.state.mode()
    const popover = input.state.popover()

    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (mode === "normal") input.pickAttachment()
      return
    }

    if (event.key === "Backspace") input.editor.collapseBackspaceAtZeroWidth()

    // Normal users type a literal `!`; shell-mode shortcuts are an Advanced+ affordance.
    if (event.key === "!" && mode === "normal" && input.advanced()) {
      if (getCursorPosition(input.editor.element()) === 0) {
        input.setMode("shell")
        input.closePopover()
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (popover) {
        input.closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (mode === "shell") {
        input.setMode("normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (input.working()) {
        void input.abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (input.blurOnEscape()) {
        input.editor.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (mode === "shell") {
      const { collapsed, cursorPosition, textLength } = input.editor.caret()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        input.setMode("normal")
        event.preventDefault()
        return
      }
    }

    // Shift+Enter is never an IME commit and must always insert a newline.
    if (event.key === "Enter" && event.shiftKey) {
      input.addNewline()
      event.preventDefault()
      return
    }
    if (event.key === "Enter" && input.composing(event)) return

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (popover) {
      if (event.key === "Tab") {
        input.selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (popover === "at") {
          input.atKeyDown(event)
          event.preventDefault()
          return
        }
        input.slashKeyDown(event)
        if (event.key === "ArrowUp" || event.key === "ArrowDown" || ctrlNav) input.scrollSlashActiveIntoView()
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (popover) {
        input.closePopover()
        event.preventDefault()
        return
      }
      if (input.working()) {
        void input.abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (!input.editor.caret().collapsed) return
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (
        !canNavigateHistoryAtCursor(
          direction,
          input.promptText(),
          getCursorPosition(input.editor.element()),
          input.state.historyIndex() >= 0,
        )
      )
        return
      if (input.navigateHistory(direction)) event.preventDefault()
      return
    }

    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    if (event.repeat) return
    if (input.working() && !input.promptText().trim() && !input.attachmentCount() && !input.commentCount()) return
    void input.submit(event)
  }
}
