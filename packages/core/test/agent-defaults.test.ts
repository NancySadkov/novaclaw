import { describe, expect, test } from "bun:test"
import { AgentDefaults } from "@novaclaw/core/session/agent-defaults"
import { EFFECTIVE_CONFIG_DEFAULTS } from "@novaclaw/core/session/config-resolve"
import { ProjectDefaults } from "@novaclaw/core/session/project-defaults"
import type { ConfigAgent } from "@novaclaw/core/config/agent"

// A COLLEAGUE's standing work choices (owner, 2026-08-21: the Chat/Agent posture, Strict and the
// permission mode belong to the agent, not to a conversation).

const agent = (over: Record<string, unknown>) => over as unknown as ConfigAgent.Info

// 🔴 THE MODEL — the fold that did not exist, and the feature that therefore did not happen.
//
// "A model belongs to the COLLEAGUE, not to the chat" is why the picker moved into the Tune dialog
// and the composer's per-chat chip was deleted on 2026-08-22. Nothing carried it: the resolver reads
// `session.model` (the session ROW) or the catalog default and has never consulted the agent
// registry, `startChat` sends only `{agent, title}`, and `model` was in no fold. Measured live the
// same day — a colleague configured `ghostprovider/nosuchmodel` ran on the instance default and
// never touched its own setting, with no fallback logged because there was nothing to fall back
// from. After the fold: `model.requested "ghostprovider/nosuchmodel"`, `model.used
// "spark-holo/holo3.1"`, `model.reason "unavailable"`.
describe("the colleague's model", () => {
  test("a declared model becomes the chat's model, parsed into a REF", () => {
    // ⚠️ The shape boundary is the whole reason this is not just another `DECLARABLE` entry: config
    // carries `"providerID/modelID"` as a string, `EffectiveConfig.model` is `{ providerID, id }`.
    // Assigning the string through the generic loop would leave `select()` matching nothing — the
    // same boundary that broke `agent-clone.ts`.
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ model: "spark-holo/holo3.1" }))
    expect(folded.model).toEqual({ providerID: "spark-holo", id: "holo3.1" })
  })

  test("a model id containing a slash keeps it — only the FIRST segment is the provider", () => {
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ model: "endpoint-a/hf.co/unsloth/Qwen3.6" }))
    expect(folded.model).toEqual({ providerID: "endpoint-a", id: "hf.co/unsloth/Qwen3.6" })
  })

  test("a declared variant rides with it", () => {
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ model: "a/b", variant: "thinking" }))
    expect(folded.model).toEqual({ providerID: "a", id: "b", variant: "thinking" })
  })

  test("no model declared leaves the base alone — the instance default still applies", () => {
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ title: "Bookkeeper" })).model).toBeUndefined()
  })

  test("an EMPTY model string is not a declaration", () => {
    // A cleared picker writes "" through some paths; treating it as a ref would resolve to a model
    // whose provider and id are both empty and fail every match.
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ model: "  " })).model).toBeUndefined()
  })
})

// 🔴 `declaredBy` and `fold` are TWO lists that must agree and cannot share a loop — `model` needs a
// shape conversion the generic loop cannot do. A fork between them is a surface naming the wrong
// author, silently.
describe("who declared what", () => {
  test("every field the fold CHANGES is one declaredBy reports", () => {
    const colleague = agent({
      model: "spark-holo/holo3.1",
      permissionMode: "plan",
      shortChat: true,
      strict: { enabled: true },
      reground: false,
      reasoningBudget: 0,
    })
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, colleague)
    const changed = Object.keys(folded).filter(
      (key) =>
        JSON.stringify((folded as unknown as Record<string, unknown>)[key]) !==
        JSON.stringify((EFFECTIVE_CONFIG_DEFAULTS as unknown as Record<string, unknown>)[key]),
    )
    expect([...AgentDefaults.declaredBy(colleague)].sort()).toEqual(changed.sort())
  })

  test("a colleague that declares nothing authored nothing", () => {
    expect(AgentDefaults.declaredBy(agent({ title: "Auditor" }))).toEqual([])
    expect(AgentDefaults.declaredBy(undefined)).toEqual([])
  })

  test("an empty model string is not authorship", () => {
    expect(AgentDefaults.declaredBy(agent({ model: "  " }))).toEqual([])
  })
})

describe("a colleague's standing choices", () => {
  test("declared fields become the baseline its chats start from", () => {
    const folded = AgentDefaults.fold(
      EFFECTIVE_CONFIG_DEFAULTS,
      agent({ permissionMode: "plan", strict: { enabled: true } }),
    )
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

  test("only the five WORK choices are declarable", () => {
    expect([...AgentDefaults.DECLARABLE].sort()).toEqual([
      "permissionMode",
      "reasoningBudget",
      "reground",
      "shortChat",
      "strict",
    ])
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

  test("two colleagues can hold opposite re-ground stances", () => {
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ reground: true })).reground).toBe(true)
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ reground: false })).reground).toBe(false)
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({})).reground).toBeUndefined()
  })

  test("reasoning budget inherits from the model unless the officer overrides it, including zero", () => {
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({})).reasoningBudget).toBeUndefined()
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ reasoningBudget: 0 })).reasoningBudget).toBe(0)
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ reasoningBudget: 2048 })).reasoningBudget).toBe(2048)
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
