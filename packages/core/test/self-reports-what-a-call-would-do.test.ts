import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
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

  /**
   * 🔴 The verdict comes from what a REAL CALL would answer, not from re-evaluating rules here.
   * An earlier version evaluated the agent ruleset alone and documented the gap, on the belief that
   * `ask` records a pending request so a capability REPORT could not use it. That was STALE — `ask`
   * stopped creating pending records when `evaluateInput` lost its "ask" outcome, and its own
   * comment says so. These stub the verdict to pin the SHAPE: which colleagues get asked about, and
   * what the answers mean.
   */
  const can = (input: { allowed?: readonly string[]; paused?: boolean }) => {
    const asked: string[] = []
    const result = Effect.runSync(
      SelfTool.addressableByMe({
        own: { paused: input.paused },
        selfID: "aris",
        roster: ROSTER,
        verdict: (colleague) => {
          asked.push(colleague)
          return Effect.succeed((input.allowed ?? []).includes(colleague))
        },
      }),
    )
    return { result, asked }
  }

  test("🔴 it reports what the call would do — allowed for one colleague is CAN", () => {
    expect(can({ allowed: ["bookkeeper"] }).result).toBe(true)
  })

  test("🔴 refused everywhere is CANNOT, however permissive the agent's own rules are", () => {
    // The gap this closed: the agent ruleset could say allow while the mode overlay, a saved answer
    // or the project file denied — and `self` promised what every call then refused.
    expect(can({ allowed: [] }).result).toBe(false)
  })

  test("🔴 a PAUSED colleague reports false without asking anybody", () => {
    const { result, asked } = can({ allowed: ["theron"], paused: true })
    expect(result).toBe(false)
    expect(asked).toEqual([])
  })

  test("⚠️ SELF, sub-agents and postures are never asked about", () => {
    // `explore` is machinery and `build` is a posture; asking about either would spend an
    // evaluation on somebody you cannot address anyway.
    expect(can({ allowed: [] }).asked).toEqual(["theron", "bookkeeper"])
  })

  test('⚠️ it STOPS at the first yes — the question is "any", not "all"', () => {
    expect(can({ allowed: ["theron"] }).asked).toEqual(["theron"])
  })

  test("an empty roster reports false rather than throwing", () => {
    expect(
      Effect.runSync(
        SelfTool.addressableByMe({ own: {}, selfID: "aris", roster: [], verdict: () => Effect.succeed(true) }),
      ),
    ).toBe(false)
  })
})
