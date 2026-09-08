import { describe, expect, test } from "bun:test"
import { JhBudget } from "./budget"

const tel = (over: Partial<JhBudget.Telemetry>): JhBudget.Telemetry => ({ ...JhBudget.emptyTelemetry, ...over })

describe("JhBudget.observedDifficulty", () => {
  test("thresholds: 0/1/≥2 fails → trivial/moderate/hard", () => {
    expect(JhBudget.observedDifficulty(JhBudget.emptyTelemetry)).toBe("trivial")
    expect(JhBudget.observedDifficulty(tel({ verifierFails: 1 }))).toBe("moderate")
    expect(JhBudget.observedDifficulty(tel({ parseFails: 1 }))).toBe("moderate")
    expect(JhBudget.observedDifficulty(tel({ verifierFails: 2 }))).toBe("hard")
  })
})

describe("JhBudget.budgetFor", () => {
  test("max(prior, observed); missing prior = moderate", () => {
    expect(JhBudget.budgetFor("trivial", JhBudget.emptyTelemetry)).toBe(1)
    expect(JhBudget.budgetFor("hard", JhBudget.emptyTelemetry)).toBe(3)
    expect(JhBudget.budgetFor(undefined, JhBudget.emptyTelemetry)).toBe(2)
    expect(JhBudget.budgetFor("trivial", tel({ verifierFails: 2 }))).toBe(3) // observed hard wins
    expect(JhBudget.budgetFor("moderate", tel({ verifierFails: 1 }))).toBe(2)
  })
})

describe("JhBudget staircase", () => {
  test("scripted [P,P,F,P,F,F,P] from init(4,1): exact level trace + reversals", () => {
    let s = JhBudget.staircaseInit(4, 1)
    const script = [true, true, false, true, false, false, true]
    const levels: number[] = []
    for (const passed of script) {
      s = JhBudget.staircaseUpdate(s, passed)
      levels.push(s.level)
    }
    expect(levels).toEqual([5, 6, 5, 6, 5, 4, 5])
    expect(s.reversals).toEqual([6, 5, 6, 4])
  })

  test("estimate undefined until 2 reversals, then the mean of the last ≤6", () => {
    let s = JhBudget.staircaseInit(4, 1)
    s = JhBudget.staircaseUpdate(s, true) // no reversal yet
    s = JhBudget.staircaseUpdate(s, true)
    s = JhBudget.staircaseUpdate(s, false) // reversal 1 (level 6)
    expect(JhBudget.staircaseEstimate(s)).toBeUndefined()
    s = JhBudget.staircaseUpdate(s, true) // reversal 2 (level 5)
    expect(JhBudget.staircaseEstimate(s)).toBe(5.5) // mean of [6,5]
  })

  test("level floors at 1", () => {
    let s = JhBudget.staircaseInit(1, 1)
    s = JhBudget.staircaseUpdate(s, false)
    expect(s.level).toBe(1)
  })
})

describe("JhBudget.shouldForceSplit", () => {
  test("default trigger boundary: cardinality 7 → false, 8 → true", () => {
    expect(JhBudget.shouldForceSplit(JhBudget.DEFAULT_TRIGGER, { cardinality: 7, density: 0 })).toBe(false)
    expect(JhBudget.shouldForceSplit(JhBudget.DEFAULT_TRIGGER, { cardinality: 8, density: 0 })).toBe(true)
  })

  test("density path also triggers (density 12 > 12-1)", () => {
    expect(JhBudget.shouldForceSplit(JhBudget.DEFAULT_TRIGGER, { cardinality: 0, density: 11 })).toBe(false)
    expect(JhBudget.shouldForceSplit(JhBudget.DEFAULT_TRIGGER, { cardinality: 0, density: 12 })).toBe(true)
  })
})
