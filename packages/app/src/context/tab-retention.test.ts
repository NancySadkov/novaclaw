import { describe, expect, test } from "bun:test"
import { appendRecentTab, OPEN_TAB_LIMIT, retainRecentTabs } from "./tab-retention"

const key = (value: string) => value

describe("automatic officer-tab retention", () => {
  test("keeps six recent officers without moving their visual positions", () => {
    expect(OPEN_TAB_LIMIT).toBe(6)
    expect(retainRecentTabs(["a", "b", "c", "d", "e", "f", "g"], ["c", "a", "d", "b", "g", "f", "e"], key)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "f",
      "g",
    ])
  })
  test("a seventh officer displaces only the least recently visited tab", () => {
    expect(appendRecentTab(["a", "b", "c", "d", "e", "f"], "g", ["c", "a", "f", "e", "d", "b"], key)).toEqual({
      tabs: ["a", "c", "d", "e", "f", "g"],
      evicted: ["b"],
    })
  })
  test("an unvisited old tab yields before one with recorded use", () => {
    expect(appendRecentTab(["a", "b", "c", "d", "e", "f"], "g", ["c", "a", "d", "e", "f"], key)).toEqual({
      tabs: ["a", "c", "d", "e", "f", "g"],
      evicted: ["b"],
    })
  })
  test("one open repairs an oversized persisted store", () => {
    expect(
      appendRecentTab(["a", "b", "c", "d", "e", "f", "g", "h"], "i", ["h", "f", "d", "b", "a", "c", "e", "g"], key),
    ).toEqual({ tabs: ["a", "b", "d", "f", "h", "i"], evicted: ["c", "e", "g"] })
  })
})
