import { describe, expect, test } from "bun:test"
import { findMatches, stepMatch } from "./terminal-search"

describe("finding text across the buffer", () => {
  const lines = ["error: connection refused", "ERROR: retrying", "all good", "error error error"]

  test("finds every occurrence in reading order", () => {
    const matches = findMatches(lines, "error")
    expect(matches).toEqual([
      { row: 0, column: 0, length: 5 },
      { row: 1, column: 0, length: 5 },
      { row: 3, column: 0, length: 5 },
      { row: 3, column: 6, length: 5 },
      { row: 3, column: 12, length: 5 },
    ])
  })

  test("case-insensitive, because a shell transcript mixes both and nobody wants a Match Case toggle first", () => {
    expect(findMatches(lines, "ERROR").length).toBe(5)
    expect(findMatches(lines, "eRrOr").length).toBe(5)
  })

  test("overlaps are not double-reported", () => {
    // "aa" in "aaa" is one match, like every editor's find. Reporting two would make next/previous
    // step through positions that visibly overlap and look like a stuck button.
    expect(findMatches(["aaa"], "aa")).toEqual([{ row: 0, column: 0, length: 2 }])
  })

  test("an empty query matches nothing rather than everything", () => {
    // The find bar calls this on every keystroke including the one that empties it; matching every
    // position there would select the whole buffer as the user deletes their query.
    expect(findMatches(lines, "")).toEqual([])
  })

  test("holes in the buffer do not throw", () => {
    expect(findMatches(["a", undefined as unknown as string, "a"], "a")).toEqual([
      { row: 0, column: 0, length: 1 },
      { row: 2, column: 0, length: 1 },
    ])
  })
})

describe("stepping between matches", () => {
  test("wraps in both directions", () => {
    expect(stepMatch(3, 2, "next")).toBe(0)
    expect(stepMatch(3, 0, "previous")).toBe(2)
  })

  test("a first press picks the end the direction implies", () => {
    expect(stepMatch(3, undefined, "next")).toBe(0)
    expect(stepMatch(3, undefined, "previous")).toBe(2)
  })

  test("no matches yields no position", () => {
    expect(stepMatch(0, undefined, "next")).toBe(-1)
    expect(stepMatch(0, 5, "previous")).toBe(-1)
  })

  test("an out-of-range position restarts instead of clamping", () => {
    // The buffer grows under a live shell while the find bar is open, so `current` can fall outside
    // the new match list. Clamping would silently reveal an unrelated match and read as a jump.
    expect(stepMatch(3, 99, "next")).toBe(0)
    expect(stepMatch(3, -4, "previous")).toBe(2)
  })
})
