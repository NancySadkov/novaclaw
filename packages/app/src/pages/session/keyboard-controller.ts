import { focusTerminalById, shouldFocusTerminalOnKeyDown } from "./helpers"

type Input = {
  composer: () => HTMLDivElement | undefined
  childSession: () => boolean
  dialogActive: () => boolean
  terminalOpen: () => boolean
  activeTerminal: () => string | undefined
}

const isEditableTarget = (target: EventTarget | null | undefined) => {
  if (!(target instanceof HTMLElement)) return false
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
}

const deepActiveElement = () => {
  let current: Element | null = document.activeElement
  while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
    current = current.shadowRoot.activeElement
  }
  return current instanceof HTMLElement ? current : undefined
}

/** Global session keyboard policy: respect focused controls, then terminal, then the composer. */
export function createSessionKeyboardController(input: Input) {
  return (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const active = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return
    if (active && (active.closest("[data-prevent-autofocus]") || isEditableTarget(active))) return
    if (input.dialogActive()) return

    const composer = input.composer()
    if (active === composer) {
      if (event.key === "Escape") composer?.blur()
      return
    }

    if (input.terminalOpen()) {
      const id = input.activeTerminal()
      if (id && shouldFocusTerminalOnKeyDown(event) && focusTerminalById(id)) return
    }

    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      return
    }

    if (event.key.length !== 1 || event.key === "Unidentified" || event.ctrlKey || event.metaKey) return
    if (input.childSession()) return
    composer?.focus()
  }
}
