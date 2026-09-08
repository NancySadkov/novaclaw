import type { Ref } from "solid-js"

/** Ordinary click jitter must not promote tab selection into a one-frame reorder gesture. */
export const TAB_DRAG_ACTIVATION_DISTANCE = 8

export function canStartTabDrag(pointerType: string) {
  return pointerType !== "touch"
}

/** Reveal a clipped tab without letting `scrollIntoView` move the page or any route-owned ancestor. */
export function revealTabInStrip(element: HTMLElement | undefined) {
  if (!element) return
  const strip = element.closest<HTMLElement>('[data-slot="titlebar-tabs-scroll"]')
  if (!strip) return
  const viewport = strip.getBoundingClientRect()
  const tab = element.getBoundingClientRect()
  if (tab.left < viewport.left) {
    strip.scrollLeft -= viewport.left - tab.left
    return
  }
  if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right
}

export function forwardTabRef(ref: Ref<HTMLDivElement> | undefined, element: HTMLDivElement) {
  if (typeof ref === "function") ref(element)
}

export function canOpenTabRename(dragging: boolean | undefined, editing: boolean, committing: boolean) {
  return !dragging && !editing && !committing
}
