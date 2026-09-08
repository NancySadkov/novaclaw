import { describe, expect, test } from "bun:test"

const titlebar = await Bun.file(new URL("./titlebar.tsx", import.meta.url)).text()
const strip = await Bun.file(new URL("./titlebar-tab-strip.tsx", import.meta.url)).text()
const sidePanel = await Bun.file(new URL("../pages/session/session-side-panel.tsx", import.meta.url)).text()

describe("narrow-window navigation remains reachable", () => {
  test("All Officers is unconditional and takes width before the shrinking tab strip", () => {
    expect(titlebar).toContain('data-component="titlebar-task-list"')
    expect(titlebar).not.toContain('<Show when={location.pathname !== "/"}>')
    expect(strip).toContain('data-slot="titlebar-tabs" class="relative min-w-0 flex-1 overflow-hidden"')
  })

  test("a shrunken tab retains enough width for a short name", () => {
    expect(strip.match(/min-w-14/g)?.length).toBe(2)
    expect(strip).not.toContain("min-w-7")
  })

  test("every sortable tab disables the post-click displacement animation", () => {
    expect(strip.match(/useSortable\(/g)?.length).toBe(1)
    expect(strip).toContain("transition: sortableTransition")
    expect(strip.match(/useTabSortable\(/g)?.length).toBe(3)
  })

  test("tab selection never asks an ancestor scroller to reposition itself", () => {
    expect(titlebar).toContain("revealTabInStrip(el)")
    expect(titlebar).not.toContain("scrollIntoView")
  })

  test("context stats can render as a modal below the desktop breakpoint", () => {
    expect(sidePanel).toContain("const reviewOpen = createMemo(() => view().reviewPanel.opened())")
    expect(sidePanel).toContain("const fileOpen = createMemo(() => isDesktop() && layout.fileTree.opened())")
    expect(sidePanel).toContain("<Show when={!!params.id && (isDesktop() || reviewOpen())}>")
  })
})
