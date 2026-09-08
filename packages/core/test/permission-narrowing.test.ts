import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@novaclaw/core/permission"
import type { Permission } from "@novaclaw/schema/permission"

/**
 * ``: *"Permissions compose as narrowing, deny-wins constraints: a Project or session
 * may never widen the operator's safety floor."*
 *
 * 🔴 This is a SECURITY boundary, not a preference. `evaluate` takes the LAST matching rule across
 * concatenated rulesets, so the ordinary way to add permissions — append — is also the way to
 * override a deny. A `novaclaw.json` lives inside a folder the user may have cloned minutes ago, so
 * the composition it gets has to be a different one, and every arm of that difference is pinned here.
 */

const rules = (...items: Array<[string, string, Permission.Effect]>): Permission.Ruleset =>
  items.map(([action, resource, effect]) => ({ action, resource, effect }))

const verdict = (base: Permission.Ruleset, constraint: Permission.Ruleset, action = "bash", resource = "ls") =>
  PermissionV2.evaluateNarrowed(action, resource, [base], [constraint]).effect

describe("a project may only narrow", () => {
  test("🔴 a project CANNOT turn an operator's deny into an allow", () => {
    // The attack this closes: a repository ships `{"action":"*","resource":"*","effect":"allow"}`,
    // and under plain concatenation it is the LAST matching rule and therefore wins.
    expect(verdict(rules(["*", "*", "deny"]), rules(["*", "*", "allow"]))).toBe("deny")
  })

  test("🔴 a project CANNOT turn an ask into an allow", () => {
    // Quieter than the deny case and worse in practice: the card the user would have seen simply
    // stops appearing, and nothing anywhere reports that a file removed it.
    expect(verdict(rules(["*", "*", "ask"]), rules(["*", "*", "allow"]))).toBe("ask")
  })

  test("a project CAN tighten allow → ask, and allow → deny", () => {
    // The direction that is always safe, and the reason projects may carry permissions at all.
    expect(verdict(rules(["*", "*", "allow"]), rules(["bash", "*", "ask"]))).toBe("ask")
    expect(verdict(rules(["*", "*", "allow"]), rules(["bash", "*", "deny"]))).toBe("deny")
  })

  test("a project CAN tighten ask → deny", () => {
    expect(verdict(rules(["*", "*", "ask"]), rules(["bash", "*", "deny"]))).toBe("deny")
  })

  test("🔴 a constraint with NO matching rule changes NOTHING", () => {
    // The failure this prevents is the opposite one, and it would make the feature unusable: silence
    // read as `ask` would mean an empty project file tightens every action the operator allowed.
    expect(verdict(rules(["*", "*", "allow"]), [])).toBe("allow")
    expect(verdict(rules(["*", "*", "allow"]), rules(["webfetch", "*", "deny"]))).toBe("allow")
  })

  test("within one ruleset the LAST matching rule still wins — narrowing is BETWEEN rulesets", () => {
    // A project author must be able to write "deny everything, except this" in their own file.
    expect(verdict(rules(["*", "*", "allow"]), rules(["*", "*", "deny"], ["bash", "ls", "ask"]))).toBe("ask")
  })

  test("the verdict keeps the ORIGIN rule, so a caller can say which file denied them", () => {
    const winner = PermissionV2.evaluateNarrowed(
      "bash",
      "rm -rf /",
      [rules(["*", "*", "allow"])],
      [rules(["bash", "rm*", "deny"])],
    )
    // A composed verdict that cannot name its author is one nobody can act on.
    expect(winner.resource).toBe("rm*")
    expect(winner.effect).toBe("deny")
  })

  test("several constraints compose, and the most restrictive wins regardless of order", () => {
    const base = [rules(["*", "*", "allow"])]
    const ask = rules(["bash", "*", "ask"])
    const deny = rules(["bash", "*", "deny"])
    expect(PermissionV2.evaluateNarrowed("bash", "ls", base, [ask, deny]).effect).toBe("deny")
    expect(PermissionV2.evaluateNarrowed("bash", "ls", base, [deny, ask]).effect).toBe("deny")
  })

  test("with no rule anywhere the default is still ASK, not allow", () => {
    expect(PermissionV2.evaluateNarrowed("bash", "ls", [[]], [[]]).effect).toBe("ask")
  })

  test("matchRule distinguishes silence from an explicit ask", () => {
    // The distinction `evaluate` cannot make, and the whole reason this is a separate function.
    expect(PermissionV2.matchRule("bash", "ls", [])).toBeUndefined()
    expect(PermissionV2.matchRule("bash", "ls", rules(["bash", "*", "ask"]))?.effect).toBe("ask")
  })
})
