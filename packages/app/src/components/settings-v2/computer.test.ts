import { describe, expect, test } from "bun:test"
import { effectOf, withEffect } from "./computer-rules"

/**
 * These two functions carry the whole correctness of the Computer Use permission control, and they
 * are unit-tested because the UI path CANNOT be: the control is a Kobalte dropdown, and a synthetic
 * `click()` (or even a full synthetic pointer sequence) does not open it — verified by hand against
 * a running app on 2026-08-06. So the render and the display-persistence were checked live, and this
 * is the mechanical check for the part that could not be.
 *
 * Both failures below produce a control that LOOKS like it works: the row shows a value, the write
 * returns 200, and the agent's behaviour never changes.
 */
type Rule = { action?: string; resource?: string; effect?: "allow" | "ask" | "deny" }

describe("effectOf reads the FIRST match, because the ruleset is first-match-wins", () => {
  test("no rule for the action means ask — the safe default, not an absence", () => {
    expect(effectOf([])).toBe("ask")
    expect(effectOf([{ action: "bash", effect: "allow" }])).toBe("ask")
  })

  test("a single rule is reported", () => {
    expect(effectOf([{ action: "computer", resource: "*", effect: "allow" }])).toBe("allow")
  })

  test("🔴 a SHADOWED later rule is not reported as if it were in force", () => {
    // The evaluator stops at the first match, so `deny` is what actually applies. Reporting `allow`
    // here would be the settings screen contradicting the system it configures.
    const rules: Rule[] = [
      { action: "computer", resource: "*", effect: "deny" },
      { action: "computer", resource: "*", effect: "allow" },
    ]
    expect(effectOf(rules)).toBe("deny")
  })
})

describe("withEffect REPLACES rather than appends", () => {
  test("🔴 the new rule lands FIRST, so it is the one that applies", () => {
    // Appending would leave the old rule in front and the new one dead: the control would appear to
    // work, persist a change, and alter nothing.
    const next = withEffect([{ action: "computer", resource: "*", effect: "deny" }], "allow")
    expect(next[0]).toEqual({ action: "computer", resource: "*", effect: "allow" })
    expect(effectOf(next)).toBe("allow")
  })

  test("exactly one rule for the action survives, however many there were", () => {
    const messy: Rule[] = [
      { action: "computer", effect: "deny" },
      { action: "bash", effect: "allow" },
      { action: "computer", effect: "ask" },
    ]
    const next = withEffect(messy, "allow")
    expect(next.filter((r) => r.action === "computer")).toHaveLength(1)
  })

  test("every other rule keeps its relative order", () => {
    // The ruleset is ordered, so reshuffling unrelated rules would silently re-prioritise them.
    const others: Rule[] = [
      { action: "bash", effect: "ask" },
      { action: "read", effect: "allow" },
      { action: "write", effect: "deny" },
    ]
    const next = withEffect([{ action: "computer", effect: "deny" }, ...others], "ask")
    expect(next.slice(1)).toEqual(others)
  })

  test("setting an effect when none existed does not drop the existing rules", () => {
    const others: Rule[] = [{ action: "bash", effect: "ask" }]
    expect(withEffect(others, "deny")).toEqual([{ action: "computer", resource: "*", effect: "deny" }, ...others])
  })

  test("the round trip holds for every effect", () => {
    for (const effect of ["ask", "allow", "deny"] as const)
      expect(effectOf(withEffect([{ action: "computer", effect: "ask" }], effect))).toBe(effect)
  })
})
