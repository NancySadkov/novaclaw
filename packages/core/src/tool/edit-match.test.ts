import { describe, expect, test } from "bun:test"
import { AUTO_APPLY_COST_CEILING, find, replace } from "./edit-match"

describe("edit match ladder", () => {
  test("tier 1 is exact after one-to-one Unicode punctuation canonicalization", () => {
    const result = find("const label = “Nova—Claw”\n", 'const label = "Nova-Claw"')
    expect(result).toMatchObject({ matched: true, candidates: [{ tier: 1, cost: 0, start: 0 }] })
    if (!result.matched) throw new Error("expected match")
    expect(replace("const label = “Nova—Claw”\n", result.candidates, 'const label = "NovaClaw"')).toEqual({
      content: 'const label = "NovaClaw"\n',
      replacements: 1,
    })
  })

  test("tier 2 trims trailing whitespace and stays within the auto-apply ceiling", () => {
    const result = find("const a = 1  \nconst b = 2\t\n", "const a = 1\nconst b = 2")
    expect(result).toMatchObject({ matched: true, candidates: [{ tier: 2, cost: 1 }] })
    if (!result.matched) throw new Error("expected match")
    expect(result.candidates[0].cost).toBeLessThanOrEqual(AUTO_APPLY_COST_CEILING)
  })

  test("tier 3 strips both line edges but costs too much to auto-apply", () => {
    const result = find("    if (ready) {\n      run()\n    }\n", "if (ready) {\nrun()\n}")
    expect(result).toMatchObject({ matched: true, candidates: [{ tier: 3, cost: 100 }] })
    if (!result.matched) throw new Error("expected match")
    expect(result.candidates[0].cost).toBeGreaterThan(AUTO_APPLY_COST_CEILING)
  })

  test("tier 4 reports the unique best Levenshtein candidate at or above 0.66", () => {
    const result = find("alpha beta gamma delta\nunrelated words here\n", "alpha beta gamma theta")
    expect(result).toMatchObject({ matched: true, candidates: [{ tier: 4, cost: 1000, start: 0 }] })
    if (!result.matched) throw new Error("expected match")
    expect(result.candidates[0].similarity).toBeGreaterThanOrEqual(0.66)
  })

  test("below-threshold failure still returns the deterministic earliest best candidate", () => {
    const first = find("alpha\nbeta\n", "omega")
    const second = find("alpha\nbeta\n", "omega")
    expect(first).toEqual(second)
    expect(first).toMatchObject({ matched: false, best: { start: 6, tier: 4, cost: 1000 } })
  })

  test("same-tier ambiguity is preserved for the caller to refuse or replaceAll", () => {
    const result = find("value  \nother\nvalue\t\n", "value\n")
    expect(result).toMatchObject({ matched: true, candidates: [{ tier: 2 }, { tier: 2 }] })
  })

  test("overlapping replaceAll candidates are applied once and counted honestly", () => {
    const result = find("a  \na  \na  \n", "a\na")
    expect(result).toMatchObject({ matched: true, candidates: [{ tier: 2 }, { tier: 2 }] })
    if (!result.matched) throw new Error("expected match")
    expect(replace("a  \na  \na  \n", result.candidates, "b\nb")).toEqual({
      content: "b\nb\na  \n",
      replacements: 1,
    })
  })

  test("the Levenshtein rung withdraws before quadratic work exceeds its fixed bound", () => {
    const line = "x".repeat(4_000)
    expect(find(`${line}\n${line}\n${line}\n`, "y".repeat(4_000))).toEqual({ matched: false })
  })
})
