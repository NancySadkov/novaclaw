import { describe, expect, test } from "bun:test"
import { homeSessionTimeLabel, subtreeRows, tokenTotals } from "./home-session-meta"

describe("homeSessionTimeLabel", () => {
  const noon = new Date("2026-07-06T12:00:00").getTime()

  test("same-day updates show a time", () => {
    const nine = new Date("2026-07-06T09:05:00").getTime()
    const label = homeSessionTimeLabel(nine, "en", noon)
    expect(label).toMatch(/9:05/)
  })

  test("yesterday within 24h still shows a time (day comes from the group header)", () => {
    const label = homeSessionTimeLabel(noon - 20 * 60 * 60 * 1000, "en", noon)
    expect(label).toMatch(/\d{1,2}:\d{2}/)
  })

  test("older updates show a short date", () => {
    const lastMonth = new Date("2026-06-01T15:30:00").getTime()
    const label = homeSessionTimeLabel(lastMonth, "en", noon)
    expect(label).toContain("Jun")
    expect(label).not.toMatch(/\d{1,2}:\d{2}/)
  })
})

describe("subtreeRows", () => {
  const s = (id: string, parentID: string | undefined, updated: number, archived?: number) => ({
    id,
    parentID,
    time: { created: updated, updated, archived },
  })

  test("depth-orders descendants under the root, newest first per level", () => {
    const sessions = [
      s("root", undefined, 10),
      s("a", "root", 5),
      s("b", "root", 8),
      s("a1", "a", 6),
      s("other", "elsewhere", 9),
    ]
    expect(subtreeRows(sessions, "root").map((row) => `${row.session.id}@${row.depth}`)).toEqual([
      "b@1",
      "a@1",
      "a1@2",
    ])
  })

  test("skips archived children and tolerates cycles", () => {
    const sessions = [s("a", "root", 5, 99), s("b", "root", 4), s("root", "b", 1)]
    expect(subtreeRows(sessions, "root").map((row) => row.session.id)).toEqual(["b"])
  })
})

describe("tokenTotals", () => {
  test("sums usage across sessions and derives total + generated", () => {
    const totals = tokenTotals([
      { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } } },
      { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } },
      {},
    ])
    expect(totals).toEqual({
      input: 101,
      output: 22,
      reasoning: 8,
      cacheRead: 54,
      cacheWrite: 15,
      total: 131,
      // The row-badge metric: generation only — prompt ingestion never mixes in.
      generated: 30,
    })
  })
})
