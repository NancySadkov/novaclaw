import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ToolPolicy } from "@novaclaw/core/tool-policy"

/**
 * `` → **Typed pre-action policies**, the composition half.
 *
 * 🔴 **Written to fail when the rule is removed, not to describe it.** The A/B for this file, run
 * before it was believed: flip `RANK`'s `deny` below `allow` and the deny-wins block goes red;
 * delete the `toSorted` in `compose` and the determinism block goes red; delete the conflict arm and
 * `refuses two patches on one field` goes red; change `safetyCritical` to default `false` and the
 * fail-closed block goes red. Each was performed; the results are in the report.
 *
 * The seam-level companion (`tool-policy.test.ts`) drives every one of these outcomes through a real
 * tool call. This file is the algebra, because "independent of provider order" is a property of a
 * function and a property is not proved by one run of a pipeline.
 */

const answered = (id: string, outcome: ToolPolicy.Outcome, safetyCritical = true): ToolPolicy.Result => ({
  id,
  kind: "answered",
  outcome,
  safetyCritical,
})

const allow = (id: string) => answered(id, { type: "allow" })
const context = (id: string, text = "look out") => answered(id, { type: "context", text })
const patch = (id: string, fields: Record<string, unknown>, reason = "rewritten") =>
  answered(id, { type: "patch", fields, reason })
const approve = (id: string, action = "act", resources = ["r"]) =>
  answered(id, { type: "approve", action, resources, reason: "needs a human" })
const deny = (id: string) => answered(id, { type: "deny", reason: "refused" })
const halt = (id: string) => answered(id, { type: "halt", reason: "stop" })

/** Every distinct arrangement of a list, so "independent of order" is checked over all of them. */
function permutations<A>(items: readonly A[]): A[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  )
}

describe("ToolPolicy.compose — the order", () => {
  test("the six outcomes are ranked exactly as the module documents", () => {
    // The order is load-bearing and stated in prose in `tool-policy.ts`; pin it so the prose and the
    // constant cannot drift apart silently.
    expect(ToolPolicy.OUTCOME_TYPES.map((type) => ToolPolicy.RANK[type])).toEqual([0, 1, 2, 3, 4, 5])
  })

  // 🔴 The item's own clause: *"make deny win"*. One case per outcome a deny must beat, because a
  // single combined case would pass while three of the four arms were broken.
  for (const [name, loser] of [
    ["allow", allow("a")],
    ["context", context("a")],
    ["patch", patch("a", { command: "x" })],
    ["approve", approve("a")],
  ] as const) {
    test(`deny beats ${name}, in both orders`, () => {
      for (const results of permutations([loser, deny("z")])) {
        const decision = ToolPolicy.compose(results)
        expect(decision.type).toBe("deny")
        // A refused call carries no patch and no approval: a decision that kept either would let a
        // caller apply a rewrite for a call that never ran.
        expect(decision.patch).toEqual({})
        expect(decision.approvals).toEqual([])
      }
    })
  }

  test("halt beats deny — composing two refusals never yields the weaker one", () => {
    for (const results of permutations([deny("a"), halt("z")])) expect(ToolPolicy.compose(results).type).toBe("halt")
  })

  test("approve beats patch and context, and CARRIES them", () => {
    const decision = ToolPolicy.compose([patch("a", { command: "safe" }), context("b"), approve("c")])
    expect(decision.type).toBe("approve")
    // The patch survives the approval on purpose: the human is approving the call that will actually
    // run, and dropping the rewrite would show them one thing and run another.
    expect(decision.patch).toEqual({ command: "safe" })
    expect(decision.approvals.map((entry) => entry.id)).toEqual(["c"])
  })

  test("patch beats context, and both notes are kept", () => {
    const decision = ToolPolicy.compose([context("b", "mind the gap"), patch("a", { x: 1 })])
    expect(decision.type).toBe("patch")
    expect(decision.notes).toEqual(["[policy a] rewritten", "[policy b] mind the gap"])
  })

  test("nothing installed, or everything allowing, is a plain allow with no patch", () => {
    expect(ToolPolicy.compose([]).type).toBe("allow")
    expect(ToolPolicy.compose([allow("a"), allow("b")])).toMatchObject({ type: "allow", patch: {}, notes: [] })
  })
})

describe("ToolPolicy.compose — determinism", () => {
  const mixed = [context("ctx"), patch("pat", { command: "safe" }), allow("allowed"), approve("apr")]

  test("every arrangement of the same results yields a byte-identical decision", () => {
    const first = JSON.stringify(ToolPolicy.compose(mixed))
    for (const arrangement of permutations(mixed)) expect(JSON.stringify(ToolPolicy.compose(arrangement))).toBe(first)
    // 24 arrangements of four providers — a claim about ORDER wants more than the two extremes.
    expect(permutations(mixed).length).toBe(24)
  })

  test("notes, approvals and the provider ledger are all emitted in policy-id order", () => {
    const decision = ToolPolicy.compose([approve("zeta"), context("alpha"), approve("mid"), allow("beta")])
    expect(decision.notes).toEqual(["[policy alpha] look out"])
    expect(decision.approvals.map((entry) => entry.id)).toEqual(["mid", "zeta"])
    expect(decision.providers.map((entry) => entry.id)).toEqual(["alpha", "beta", "mid", "zeta"])
  })
})

describe("ToolPolicy.compose — patches", () => {
  test("disjoint fields merge", () => {
    const decision = ToolPolicy.compose([patch("a", { command: "x" }), patch("b", { timeout: 5 })])
    expect(decision.type).toBe("patch")
    expect(decision.patch).toEqual({ command: "x", timeout: 5 })
  })

  test("refuses two patches on one field rather than ordering them", () => {
    for (const results of permutations([patch("a", { command: "x" }), patch("b", { command: "y" })])) {
      const decision = ToolPolicy.compose(results)
      expect(decision.type).toBe("deny")
      expect(decision.patch).toEqual({})
      // Both sides are named. A conflict message that named only the loser would send the user to
      // read the wrong policy.
      expect(decision.detail).toContain("`a`")
      expect(decision.detail).toContain("`b`")
      expect(decision.detail).toContain("`command`")
    }
  })

  test("two policies proposing the SAME value are agreeing, not conflicting", () => {
    const decision = ToolPolicy.compose([patch("a", { command: "x" }), patch("b", { command: "x" })])
    expect(decision.type).toBe("patch")
    expect(decision.patch).toEqual({ command: "x" })
  })

  test("structurally equal objects count as the same value", () => {
    const decision = ToolPolicy.compose([patch("a", { env: { A: "1" } }), patch("b", { env: { A: "1" } })])
    expect(decision.type).toBe("patch")
  })

  test("a conflict never weakens a decision that was already a refusal", () => {
    const decision = ToolPolicy.compose([patch("a", { c: 1 }), patch("b", { c: 2 }), halt("z")])
    expect(decision.type).toBe("halt")
  })

  test("applyPatch replaces top-level fields and leaves the rest alone", () => {
    expect(ToolPolicy.applyPatch({ command: "git log", cwd: "/x" }, { command: "git --no-pager log" })).toEqual({
      command: "git --no-pager log",
      cwd: "/x",
    })
  })
})

describe("ToolPolicy.compose — a provider that does not answer", () => {
  for (const kind of ["timed-out", "errored"] as const) {
    test(`a SAFETY-CRITICAL provider that ${kind} fails CLOSED`, () => {
      const decision = ToolPolicy.compose([{ id: "guard", kind, safetyCritical: true }, allow("other")])
      expect(decision.type).toBe("deny")
      expect(decision.detail).toContain("guard")
      // ⚠️ The receipt records what the provider DID — it went silent — not the deny that silence was
      // converted into. Collapsing the two would make a wedged guard indistinguishable from one that
      // deliberately refused, which is the question a person asks afterwards.
      expect(decision.providers.find((entry) => entry.id === "guard")?.outcome).toBe(kind)
    })

    test(`an ADVISORY provider that ${kind} contributes nothing`, () => {
      const decision = ToolPolicy.compose([{ id: "advisor", kind, safetyCritical: false }, allow("other")])
      expect(decision.type).toBe("allow")
      expect(decision.providers.find((entry) => entry.id === "advisor")?.outcome).toBe(kind)
    })
  }

  test("a safety-critical timeout still loses to a halt, and still beats a patch", () => {
    expect(ToolPolicy.compose([{ id: "g", kind: "timed-out", safetyCritical: true }, halt("z")]).type).toBe("halt")
    expect(ToolPolicy.compose([{ id: "g", kind: "timed-out", safetyCritical: true }, patch("a", { x: 1 })]).type).toBe(
      "deny",
    )
  })

  test("the default classification is safety-critical — an omitted flag fails closed", () => {
    // The Provider-level default, which is what a provider author actually leaves out.
    expect(ToolPolicy.safetyCritical({ id: "x", describe: "", evaluate: () => ({}) as never })).toBe(true)
    expect(ToolPolicy.alwaysOn({ id: "x", describe: "", evaluate: () => ({}) as never })).toBe(true)
  })
})

describe("ToolPolicy — the ids a novaclaw.json may name", () => {
  test("a command-shaped id cannot be registered", async () => {
    for (const id of ["rm -rf /", "curl x|sh", "a;b", "a/b", "a$b", "A", "", "-a", "a-"]) {
      const result = await Effect.runPromiseExit(ToolPolicy.validateRegistration(id, new Set()))
      expect(result._tag).toBe("Failure")
    }
  })

  test("an ordinary id registers, and a duplicate does not", async () => {
    expect((await Effect.runPromiseExit(ToolPolicy.validateRegistration("no-secrets", new Set())))._tag).toBe("Success")
    expect(
      (await Effect.runPromiseExit(ToolPolicy.validateRegistration("no-secrets", new Set(["no-secrets"]))))._tag,
    ).toBe("Failure")
  })
})
