import { checksum } from "@novaclaw/core/util/encode"
import { createEffect } from "solid-js"

type Input = {
  root: () => HTMLDivElement | undefined
  pending: () => string | undefined
  ready: () => boolean
  setPending: (path: string | undefined) => void
  setFocused: (path: string) => void
  openPanel: () => void
  openPath: (path: string) => void
  saveScroll: (position: { x: number; y: number }) => void
}

export const reviewDiffID = (path: string) => {
  const sum = checksum(path)
  if (!sum) return
  return `session-review-diff-${sum}`
}

/** Owns focus-to-diff navigation, including the bounded wait for asynchronously rendered rows. */
export function createReviewNavigation(input: Input) {
  const top = (path: string) => {
    const root = input.root()
    if (!root) return
    const id = reviewDiffID(path)
    if (!id) return
    const element = document.getElementById(id)
    if (!(element instanceof HTMLElement) || !root.contains(element)) return
    const item = element.getBoundingClientRect()
    const viewport = root.getBoundingClientRect()
    return item.top - viewport.top + root.scrollTop
  }

  const scroll = (path: string) => {
    const root = input.root()
    if (!root) return false
    const y = top(path)
    if (y === undefined) return false
    input.saveScroll({ x: root.scrollLeft, y })
    root.scrollTo({ top: y, behavior: "auto" })
    return true
  }

  const focus = (path: string) => {
    input.openPanel()
    input.openPath(path)
    input.setFocused(path)
    input.setPending(path)
  }

  createEffect(() => {
    const pending = input.pending()
    if (!pending || !input.root() || !input.ready()) return

    const attempt = (count: number) => {
      if (input.pending() !== pending) return
      if (count > 60) {
        input.setPending(undefined)
        return
      }
      const root = input.root()
      if (!root || !scroll(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }
      const y = top(pending)
      if (y === undefined || Math.abs(root.scrollTop - y) > 1) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }
      input.setPending(undefined)
    }

    requestAnimationFrame(() => attempt(0))
  })

  return { focus, scroll }
}
