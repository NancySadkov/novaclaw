import { describe, expect, test } from "bun:test"
import { tokenTotals } from "./home-session-meta"

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
