import type { Ref } from "solid-js"

export function canStartTabDrag(pointerType: string) {
  return pointerType !== "touch"
}

export function forwardTabRef(ref: Ref<HTMLDivElement> | undefined, element: HTMLDivElement) {
  if (typeof ref === "function") ref(element)
}

export function canOpenTabRename(dragging: boolean | undefined, editing: boolean, committing: boolean) {
  return !dragging && !editing && !committing
}
