import { describe, expect, test } from "bun:test"
import { appendRecentTab, OPEN_TAB_LIMIT, retainRecentTabs } from "./tab-retention"

const key = (value: string) => value

describe("automatic task-tab retention", () => {
  test("keeps only the four most recently opened tabs without reordering them", () => {
    expect(retainRecentTabs(["a", "b", "c", "d", "e"], ["c", "a", "d", "b", "e"], key)).toEqual(["a", "b", "c", "d"])
    expect(OPEN_TAB_LIMIT).toBe(4)
  })

  test("opening a fifth tab evicts the least recently used existing tab", () => {
    expect(appendRecentTab(["a", "b", "c", "d"], "e", ["c", "a", "d", "b"], key)).toEqual({
      tabs: ["a", "c", "d", "e"],
      evicted: ["b"],
    })
  })

  test("an unvisited old tab yields before a tab with recorded use", () => {
    expect(appendRecentTab(["a", "b", "c", "d"], "e", ["c", "a", "d"], key)).toEqual({
      tabs: ["a", "c", "d", "e"],
      evicted: ["b"],
    })
  })

  test("one open repairs an oversized legacy store all the way to four", () => {
    expect(appendRecentTab(["a", "b", "c", "d", "e", "f"], "g", ["f", "d", "b", "a", "c", "e"], key)).toEqual({
      tabs: ["b", "d", "f", "g"],
      evicted: ["a", "c", "e"],
    })
  })
})
