import { describe, expect, test } from "bun:test"

const titlebar = await Bun.file(new URL("./titlebar.tsx", import.meta.url)).text()
const strip = await Bun.file(new URL("./titlebar-tab-strip.tsx", import.meta.url)).text()
const statsScreen = await Bun.file(new URL("../pages/session/officer-stats-screen.tsx", import.meta.url)).text()

describe("narrow-window navigation remains reachable", () => {
  test("the home badge keeps All Officers available without taking tab width", () => {
    expect(titlebar).toContain('onOpenOfficers={() => navigate("/tasks")}')
    expect(titlebar).not.toContain('data-component="titlebar-task-list"')
    expect(titlebar).not.toContain('<Show when={location.pathname !== "/"}>')
    expect(strip).toContain('data-slot="titlebar-tabs" class="relative min-w-0 flex-1 overflow-hidden"')
  })

  test("tab slots yield width to the responsive portrait strip", () => {
    expect(strip.match(/relative flex min-w-0 flex-1/g)?.length).toBe(2)
    expect(strip).not.toContain("min-w-14")
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

  test("officer stats occupies the session screen at every width", () => {
    expect(statsScreen).toContain("<Show when={!!params.id && view().reviewPanel.opened()}>")
    expect(statsScreen).toContain('<AppPage data-screen="officer-stats"')
    expect(statsScreen).not.toContain("Kobalte")
  })
})
