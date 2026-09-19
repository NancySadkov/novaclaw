/** Kobalte tablists consume Escape even when selection cannot be cleared. Call from the dialog's
 *  onEscapeKeyDown, after Kobalte has checked that this is the top dismissable layer. A nested menu
 *  or dialog keeps its own Escape; a focused tab must not trap the enclosing dialog open. */
export function dismissDialogFromTabList(event: KeyboardEvent, close: () => void) {
  if (!(event.target instanceof Element) || !event.target.closest('[role="tablist"]')) return
  event.preventDefault()
  close()
}
