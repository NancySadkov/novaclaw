import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  AUTO_FLOOR,
  AUTO_UNATTENDED_CEILING,
  autoCeiling,
  autoResolvedMode,
  chainAutoGrant,
  modeRank,
  moreRestrictive,
  type PermissionMode,
  type RootType,
  type SessionLike,
} from "@novaclaw/core/session/config-resolve"
import { PermissionTool } from "@novaclaw/core/tool/permission"

// Auto mode (todo/permissions.md) — the PURE half: the ceiling algebra in `session/config-resolve.ts`
// and the decision function in `tool/permission.ts`. The effectful halves are pinned separately by
// `permission-auto-mode.test.ts` (the live evaluator) and `tool-permission.test.ts` (the tool).

const MODES: readonly PermissionMode[] = ["plan", "ask", "surgical", "bypass", "yolo"]
const ATTENDED: readonly RootType[] = ["interactive", "sub-agent"]
const UNATTENDED: readonly RootType[] = ["auto-prompting", "goal-oriented", "unknown"]

describe("auto mode: the ladder is untouched", () => {
  // The item's ONE hard shape rule: "`auto` is not a sixth rung". A rung added to MODE_RANK would
  // re-rank every clamp, every inheritance test and every stored `permission_mode` value.
  test("MODE_RANK still holds exactly the five rungs, in order", () => {
    expect(MODES.map(modeRank)).toEqual([0, 1, 2, 3, 4])
    expect(AUTO_FLOOR).toBe("plan")
    expect(modeRank(AUTO_FLOOR)).toBe(0)
  })
})

describe("autoResolvedMode: a self-grant can only NARROW", () => {
  test("no grant anywhere means no change at all — including the unattended `yolo` escape hatch", () => {
    for (const rootType of [...ATTENDED, ...UNATTENDED])
      for (const resolvedMode of MODES) expect(autoResolvedMode({ resolvedMode, rootType })).toBe(resolvedMode)
    // Named explicitly because it is the one that would be easy to "fix" into a regression: an
    // UNATTENDED root the USER set to yolo keeps yolo while it holds no grant. That is the
    // documented way out of the deny-fast stance (`config-resolve.ts` §UNATTENDED CONFINEMENT), and
    // capping it here would silently rewrite a posture the user chose.
    expect(autoResolvedMode({ resolvedMode: "yolo", rootType: "goal-oriented" })).toBe("yolo")
  })

  test("THE invariant: for every (mode × grant × root type), the grant never widens", () => {
    for (const rootType of [...ATTENDED, ...UNATTENDED])
      for (const resolvedMode of MODES)
        for (const grant of MODES) {
          const effective = autoResolvedMode({ resolvedMode, rootType, grant })
          expect(modeRank(effective)).toBeLessThanOrEqual(modeRank(resolvedMode))
        }
  })

  test("NEGATIVE CONTROL: fold with 'take the grant' instead of `moreRestrictive` and it widens", () => {
    // The shape this file exists to forbid — a self-grant that REPLACES the user's pick. If
    // `autoResolvedMode` is ever rewritten this way the test above goes red; this one stays green
    // and names what broke.
    const widening = (_resolvedMode: PermissionMode, grant: PermissionMode) => grant
    expect(modeRank(widening("ask", "yolo"))).toBeGreaterThan(modeRank("ask"))
    // ...while the shipped fold refuses to, from the same inputs.
    expect(autoResolvedMode({ resolvedMode: "ask", rootType: "interactive", grant: "yolo" })).toBe("ask")
  })

  test("an ATTENDED chain may hold anything up to the user's pick, and nothing above it", () => {
    for (const rootType of ATTENDED) {
      expect(autoResolvedMode({ resolvedMode: "yolo", rootType, grant: "yolo" })).toBe("yolo")
      expect(autoResolvedMode({ resolvedMode: "yolo", rootType, grant: "plan" })).toBe("plan")
      expect(autoResolvedMode({ resolvedMode: "bypass", rootType, grant: "yolo" })).toBe("bypass")
    }
  })

  test("an UNATTENDED (or unreadable) chain can never grant itself `yolo`", () => {
    for (const rootType of UNATTENDED) {
      // The user set yolo AND the session self-manages: the cap bites the moment a grant exists.
      expect(autoResolvedMode({ resolvedMode: "yolo", rootType, grant: "yolo" })).toBe(AUTO_UNATTENDED_CEILING)
      expect(autoCeiling({ resolvedMode: "yolo", rootType })).toBe(AUTO_UNATTENDED_CEILING)
    }
    // `"unknown"` takes the restrictive arm — the tri-state exists for exactly this, and a chain we
    // could not read is not evidence that somebody is watching.
    expect(autoCeiling({ resolvedMode: "yolo", rootType: "unknown" })).toBe("bypass")
  })

  test("NEGATIVE CONTROL: the cap is what bites, not the fold", () => {
    // Same computation with the cap raised to `yolo`: the refusal disappears. So flipping
    // AUTO_UNATTENDED_CEILING genuinely inverts the decision above rather than the test passing for
    // some unrelated reason.
    expect(moreRestrictive("yolo", "yolo" as PermissionMode)).toBe("yolo")
    expect(moreRestrictive("yolo", AUTO_UNATTENDED_CEILING)).toBe("bypass")
    expect(AUTO_UNATTENDED_CEILING).toBe("bypass")
  })
})

describe("autoCeiling: an ancestor's self-revocation binds its children", () => {
  test("the ceiling is the most restrictive of the pick, the attendance cap and the ancestor grant", () => {
    expect(autoCeiling({ resolvedMode: "bypass", rootType: "interactive" })).toBe("bypass")
    expect(autoCeiling({ resolvedMode: "bypass", rootType: "interactive", ancestorGrant: "plan" })).toBe("plan")
    expect(autoCeiling({ resolvedMode: "yolo", rootType: "interactive", ancestorGrant: "surgical" })).toBe("surgical")
    // An ancestor that is MORE capable than the pick cannot lift the pick.
    expect(autoCeiling({ resolvedMode: "ask", rootType: "interactive", ancestorGrant: "yolo" })).toBe("ask")
  })
})

describe("chainAutoGrant: the root-ward fold", () => {
  const walk = (rows: Record<string, SessionLike>, grants: Record<string, PermissionMode>, from: string) =>
    Effect.runSync(
      chainAutoGrant(
        from,
        (id: string) => Effect.succeed(rows[id]),
        (id) => grants[id],
      ),
    )

  const family: Record<string, SessionLike> = {
    root: { id: "root" },
    kid: { id: "kid", parentID: "root" },
    grandkid: { id: "grandkid", parentID: "kid" },
  }

  test("no grant anywhere is `undefined` — the evaluator's skip path stays honest", () => {
    expect(walk(family, {}, "grandkid")).toBeUndefined()
  })

  test("a PARENT's grant reaches a child that never called the tool", () => {
    // This is the spawn-escape: a child resolves its mode from the parent's stored ROW, which a
    // self-grant deliberately never touches. Without this fold, "drop capabilities from itself AND
    // ITS CHILDREN" (todo.md → Vision) would be escapable by spawning a helper.
    expect(walk(family, { root: "plan" }, "grandkid")).toBe("plan")
    expect(walk(family, { kid: "ask" }, "grandkid")).toBe("ask")
  })

  test("the MOST RESTRICTIVE grant on the chain wins, in either order", () => {
    expect(walk(family, { root: "plan", grandkid: "bypass" }, "grandkid")).toBe("plan")
    expect(walk(family, { root: "bypass", grandkid: "plan" }, "grandkid")).toBe("plan")
  })

  test("a cycle terminates, and a dangling parent stops the walk without losing what it read", () => {
    const cyclic: Record<string, SessionLike> = { a: { id: "a", parentID: "b" }, b: { id: "b", parentID: "a" } }
    expect(walk(cyclic, { b: "plan" }, "a")).toBe("plan")
    const dangling: Record<string, SessionLike> = { kid: { id: "kid", parentID: "gone" } }
    expect(walk(dangling, { kid: "surgical" }, "kid")).toBe("surgical")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The tool's decision function.
// ─────────────────────────────────────────────────────────────────────────────

const state = (input: Partial<PermissionTool.State> = {}): PermissionTool.State => ({
  current: "bypass",
  ceiling: "bypass",
  resolvedMode: "bypass",
  attended: true,
  ...input,
})

const call = (input: {
  op: PermissionTool.Op
  target: PermissionMode
  justification?: string
  state?: PermissionTool.State
}) =>
  PermissionTool.decide({
    op: input.op,
    target: input.target,
    justification: input.justification ?? "the plan is agreed and I now need to edit src/",
    state: input.state ?? state(),
  })

describe("the written justification is the product feature, not paperwork", () => {
  test("an EMPTY justification is refused, and so is a whitespace-only one", () => {
    for (const justification of ["", "   ", "\n\t "]) {
      const decision = call({ op: "lower", target: "plan", justification })
      expect(decision.kind).toBe("refused")
      expect(decision.kind === "refused" && decision.message).toContain("empty")
    }
  })

  test("a perfunctory justification is refused and says how short it was", () => {
    const decision = call({ op: "raise", target: "bypass", justification: "ok", state: state({ current: "plan" }) })
    expect(decision.kind).toBe("refused")
    expect(decision.kind === "refused" && decision.message).toContain("too short")
  })

  test("it is checked FIRST — even a lowering, which is otherwise always permitted, is refused", () => {
    expect(call({ op: "lower", target: "plan", justification: "" }).kind).toBe("refused")
    // NEGATIVE CONTROL: the identical call with a real justification is granted, so the refusal
    // above is the justification check and nothing else.
    expect(call({ op: "lower", target: "plan" })).toEqual({ kind: "granted", approval: false })
  })

  test("the length floor is the constant, not a magic number in the message", () => {
    expect(PermissionTool.justificationProblem("x".repeat(PermissionTool.MIN_JUSTIFICATION_CHARS))).toBeUndefined()
    expect(PermissionTool.justificationProblem("x".repeat(PermissionTool.MIN_JUSTIFICATION_CHARS - 1))).toContain(
      "too short",
    )
  })
})

describe("decide: lowering is always permitted, raising is bounded", () => {
  test("lowering never asks", () => {
    for (const target of ["plan", "ask", "surgical"] as const)
      expect(
        call({ op: "lower", target, state: state({ current: "yolo", ceiling: "yolo", resolvedMode: "yolo" }) }),
      ).toEqual({ kind: "granted", approval: false })
  })

  test("raising WITHIN the ceiling is granted and does not ask", () => {
    expect(call({ op: "raise", target: "bypass", state: state({ current: "plan" }) })).toEqual({
      kind: "granted",
      approval: false,
    })
  })

  test("raising PAST the ceiling is refused outright and names the user's pick", () => {
    const decision = call({
      op: "raise",
      target: "bypass",
      state: state({ current: "plan", ceiling: "plan", resolvedMode: "plan" }),
    })
    expect(decision.kind).toBe("refused")
    expect(decision.kind === "refused" && decision.message).toContain("the user set this chat to")
    // NEGATIVE CONTROL: lift only the ceiling and the same call is granted, so it is the ceiling
    // that refuses rather than the direction check or the justification.
    expect(call({ op: "raise", target: "bypass", state: state({ current: "plan" }) }).kind).toBe("granted")
  })

  test("an UNATTENDED chain is refused `yolo` with the attendance reason, not the pick reason", () => {
    const decision = call({
      op: "raise",
      target: "yolo",
      state: state({ current: "bypass", ceiling: "bypass", resolvedMode: "yolo", attended: false }),
    })
    expect(decision.kind).toBe("refused")
    expect(decision.kind === "refused" && decision.message).toContain("UNATTENDED")
    // ...and it says plainly that no prompt can lift it, because an ask nobody can answer is a hang.
    expect(decision.kind === "refused" && decision.message).toContain("no approval prompt can lift it")
  })

  test("an ancestor's revocation is reported as such, not blamed on the user", () => {
    const decision = call({
      op: "raise",
      target: "bypass",
      state: state({ current: "plan", ceiling: "plan", resolvedMode: "bypass" }),
    })
    expect(decision.kind).toBe("refused")
    expect(decision.kind === "refused" && decision.message).toContain("lowered itself")
  })

  test("a raise that is really a lowering (and the reverse) is refused rather than silently obeyed", () => {
    const down = call({ op: "raise", target: "plan", state: state({ current: "bypass" }) })
    expect(down.kind).toBe("refused")
    expect(down.kind === "refused" && down.message).toContain('{"op":"lower"}')
    const up = call({ op: "lower", target: "bypass", state: state({ current: "plan" }) })
    expect(up.kind).toBe("refused")
    expect(up.kind === "refused" && up.message).toContain('{"op":"raise"}')
  })

  test("asking for the level it already holds is UNCHANGED, never a reported success", () => {
    const decision = call({ op: "raise", target: "bypass", state: state({ current: "bypass" }) })
    expect(decision.kind).toBe("unchanged")
    // The one case worth warning about: it holds a level the user granted that it could not grant
    // itself, so lowering is one-way.
    const warned = call({
      op: "raise",
      target: "yolo",
      state: state({ current: "yolo", ceiling: "bypass", resolvedMode: "yolo", attended: false }),
    })
    expect(warned.kind).toBe("unchanged")
    expect(warned.kind === "unchanged" && warned.message).toContain("you cannot come back")
  })
})

describe("the one consent path", () => {
  test("only a raise ABOVE the configured rung routes through the permission ask", () => {
    expect(PermissionTool.ASSERT_ABOVE).toBe("bypass")
    for (const target of ["plan", "ask", "surgical", "bypass"] as const)
      expect(PermissionTool.needsApproval(target)).toBe(false)
    expect(PermissionTool.needsApproval("yolo")).toBe(true)
  })

  test("a `yolo` raise inside an attended ceiling is granted WITH approval", () => {
    expect(
      call({ op: "raise", target: "yolo", state: state({ current: "plan", ceiling: "yolo", resolvedMode: "yolo" }) }),
    ).toEqual({ kind: "granted", approval: true })
  })

  test("a lowering to `yolo` is impossible, so approval is scoped to raises only", () => {
    // `yolo` is the top rung; a "lower" naming it can only be a direction error, never a grant that
    // skips the card.
    expect(call({ op: "lower", target: "yolo", state: state({ current: "plan" }) }).kind).toBe("refused")
  })
})
