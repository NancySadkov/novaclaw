import { describe, expect, test } from "bun:test"
import { AgentDefaults } from "@novaclaw/core/session/agent-defaults"
import { EFFECTIVE_CONFIG_DEFAULTS } from "@novaclaw/core/session/config-resolve"
import { ProjectDefaults } from "@novaclaw/core/session/project-defaults"
import type { ConfigAgent } from "@novaclaw/core/config/agent"

// A COLLEAGUE's standing work choices (owner, 2026-08-21: the Chat/Agent posture, Strict and the
// permission mode belong to the agent, not to a conversation).

const agent = (over: Record<string, unknown>) => over as unknown as ConfigAgent.Info

describe("a colleague's standing choices", () => {
  test("declared fields become the baseline its chats start from", () => {
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ permissionMode: "plan", strict: { enabled: true } }))
    expect(folded.permissionMode).toBe("plan")
    expect(folded.strict).toEqual({ enabled: true })
  })

  test("an undeclared field leaves the base alone — absent means INHERIT", () => {
    // The same rule a session row follows. Coalescing to a default here would stamp every colleague
    // with a stance nobody chose, which is what makes "absent" load-bearing.
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ strict: { enabled: true } }))
    expect(folded.permissionMode).toBe(EFFECTIVE_CONFIG_DEFAULTS.permissionMode)
  })

  test("no colleague at all is the shipped baseline, not an empty object", () => {
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, undefined)).toEqual({ ...EFFECTIVE_CONFIG_DEFAULTS })
  })

  test("only the three WORK choices are declarable", () => {
    // A colleague does not get to preset somebody's thinking budget: these are standing choices about
    // how it works, not a second copy of the session config.
    expect([...AgentDefaults.DECLARABLE].sort()).toEqual(["permissionMode", "shortChat", "strict"])
    const folded = AgentDefaults.fold(
      EFFECTIVE_CONFIG_DEFAULTS,
      agent({ thinkingBudget: false, memory: false, permissionMode: "plan" }),
    )
    expect(folded.thinkingBudget).toBe(EFFECTIVE_CONFIG_DEFAULTS.thinkingBudget)
    expect(folded.memory).toBe(EFFECTIVE_CONFIG_DEFAULTS.memory)
  })

  test("declaredBy reports what the colleague actually set", () => {
    expect(AgentDefaults.declaredBy(agent({ strict: { enabled: true }, title: "Bookkeeper" }))).toEqual(["strict"])
    expect(AgentDefaults.declaredBy(undefined)).toEqual([])
  })
})

describe("the colleague sits UNDER the folder, and today they cannot contend", () => {
  test("the two layers are DISJOINT — measured, not assumed", () => {
    // 🔴 The ordering was chosen as a security decision (principle 13: a folder may raise a
    // supervision rail and never lower one, so the colleague must not be able to widen it again).
    // Measured while writing this: they cannot contend at all today, because a folder may only
    // influence the WIRED features and a colleague declares three that are not among them.
    //
    // ⚠️ Kept as a test rather than a comment so the day the sets OVERLAP, somebody has to look at
    // this ordering deliberately instead of discovering it as a widened rail.
    const overlap = AgentDefaults.DECLARABLE.filter((field) =>
      (ProjectDefaults.WIRED as readonly string[]).includes(field),
    )
    expect(overlap).toEqual([])
  })

  test("the colleague outranks the shipped baseline for what it does declare", () => {
    const base = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ shortChat: true, permissionMode: "plan" }))
    expect(ProjectDefaults.fold(base, undefined).defaults).toMatchObject({
      shortChat: true,
      permissionMode: "plan",
    })
  })

  test("a folder still lands its own features over the colleague's baseline", () => {
    // The layers coexist: the colleague sets how it works, the folder still tunes what it is allowed
    // to do in that project.
    const base = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ strict: { enabled: true } }))
    // ⚠️ The tune's shape is `{ features: {...} }`, not a bare map — a fixture that guesses the shape
    // tests the fixture. This one was wrong on the first attempt and the test said so.
    const withFolder = ProjectDefaults.fold(base, { features: { safeMode: true } } as never)
    expect(withFolder.defaults.safeMode).toBe(true)
    expect(withFolder.defaults.strict).toEqual({ enabled: true })
  })
})
