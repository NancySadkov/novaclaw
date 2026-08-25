import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SelfTool } from "@novaclaw/core/tool/self"

/**
 * `self` MUST NOT PROMISE WHAT EVERY CALL REFUSES.
 *
 * `canAddressColleagues` was `permissions.some(r => r.action === "colleague" && r.effect === "allow")`
 * — a scan that got three things wrong at once, every one of them in the direction of over-promising:
 * it ignored rule ORDER, it ignored WILDCARDS, and it ignored the PAUSED deny-all.
 *
 * These pin the EVALUATOR's answers for the exact rulesets that scan got wrong, so the field can be
 * read against the rule a real call uses.
 */

const allow = (action: string, resource: string) => ({ action, resource, effect: "allow" as const })
const deny = (action: string, resource: string) => ({ action, resource, effect: "deny" as const })
const verdict = (rules: PermissionV2.Ruleset, who = "theron") => PermissionV2.evaluate("colleague", who, rules).effect

describe("what the scan got wrong, and the evaluator gets right", () => {
  test("🔴 ORDER: a later deny wins over an earlier allow", () => {
    // `some()` found the allow and stopped. `evaluate` is `findLast` precisely so the later rule wins.
    expect(verdict([allow("colleague", "*"), deny("colleague", "*")])).toBe("deny")
  })

  test('🔴 WILDCARDS: an `action: "*"` deny is invisible to an `=== "colleague"` test', () => {
    expect(verdict([allow("colleague", "*"), deny("*", "*")])).toBe("deny")
  })

  test('🔴 …and an `action: "*"` ALLOW counts, which the scan also missed', () => {
    // The same blindness under-reporting: a colleague allowed everything was told it could delegate
    // to nobody.
    expect(verdict([allow("*", "*")])).toBe("allow")
  })

  test("a NARROW allow names one colleague, and does not leak to another", () => {
    // Why the field asks per-colleague rather than against `resource: "*"`: "may ask the bookkeeper,
    // not the trader" must read as CAN address colleagues, not as cannot.
    const rules = [allow("colleague", "bookkeeper")]
    expect(verdict(rules, "bookkeeper")).toBe("allow")
    expect(verdict(rules, "trader")).not.toBe("allow")
  })

  test("an empty ruleset does not silently allow", () => {
    expect(verdict([])).not.toBe("allow")
  })
})

/**
 * …and the FIELD itself, which is the half the evaluator tests above cannot reach: the rule being
 * right does not mean `self` asks it.
 */
describe("what `self` reports", () => {
  const ROSTER = [
    { id: "theron", mode: "primary" },
    { id: "bookkeeper", mode: "primary" },
    { id: "explore", mode: "subagent" },
    { id: "build", mode: "primary" },
  ]
  const can = (rules: PermissionV2.Ruleset, paused?: boolean) =>
    SelfTool.addressableByMe({ permissions: rules, paused }, "aris", ROSTER)

  test("🔴 a later deny wins — the field no longer promises what a call refuses", () => {
    expect(can([allow("colleague", "*"), deny("colleague", "*")])).toBe(false)
    expect(can([allow("colleague", "*")])).toBe(true)
  })

  test("🔴 a PAUSED colleague reports false whatever its rules say", () => {
    // The evaluator answers deny-`*` for a set-aside colleague, and no configured rule reflects that.
    // Reporting true tells the model it may delegate, and every attempt is then refused.
    expect(can([allow("*", "*")], true)).toBe(false)
    expect(can([allow("*", "*")], false)).toBe(true)
  })

  test("a NARROW allow still counts as CAN address colleagues", () => {
    // Asking against `resource: "*"` would answer "may address EVERY colleague" and report false
    // here — the same lie in the other direction.
    expect(can([allow("colleague", "bookkeeper")])).toBe(true)
  })

  test("⚠️ SELF does not count, and neither does a sub-agent or a posture", () => {
    // A roster of one — yourself — is not somebody to delegate to. Nor is `explore` (machinery) or
    // `build` (a posture, excluded by `isColleague`).
    expect(
      SelfTool.addressableByMe({ permissions: [allow("*", "*")] }, "aris", [{ id: "aris", mode: "primary" }]),
    ).toBe(false)
    expect(
      SelfTool.addressableByMe({ permissions: [allow("*", "*")] }, "aris", [
        { id: "explore", mode: "subagent" },
        { id: "build", mode: "primary" },
      ]),
    ).toBe(false)
  })

  test("an empty roster reports false rather than throwing", () => {
    expect(SelfTool.addressableByMe({ permissions: [allow("*", "*")] }, "aris", [])).toBe(false)
  })
})
