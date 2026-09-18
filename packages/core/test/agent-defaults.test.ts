import { describe, expect, test } from "bun:test"
import { AgentDefaults } from "@novaclaw/core/session/agent-defaults"
import { EFFECTIVE_CONFIG_DEFAULTS } from "@novaclaw/core/session/config-resolve"
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
      reasoningBudget: 0,
      maxToolTimeoutMs: 90_000,
      contextBudget: false,
      surgicalEdits: true,
      introspection: true,
      quality: true,
      affective: true,
      tools: { bash: false },
      adhocTools: [],
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

  test("only the standing WORK choices are declarable", () => {
    expect([...AgentDefaults.DECLARABLE].sort()).toEqual([
      "adhocTools",
      "affective",
      "contextBudget",
      "introspection",
      "maxToolTimeoutMs",
      "permissionMode",
      "quality",
      "reasoningBudget",
      "shortChat",
      "strict",
      "surgicalEdits",
      "tools",
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

  test("reasoning budget inherits from the model unless the officer overrides it, including zero", () => {
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({})).reasoningBudget).toBeUndefined()
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ reasoningBudget: 0 })).reasoningBudget).toBe(0)
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ reasoningBudget: 2048 })).reasoningBudget).toBe(2048)
  })

  test("tool deadline is inherited by the officer's spawned workers", () => {
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({})).maxToolTimeoutMs).toBeUndefined()
    expect(AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ maxToolTimeoutMs: 90_000 })).maxToolTimeoutMs).toBe(
      90_000,
    )
  })

  test("full Strict detail folds as one standing choice", () => {
    const folded = AgentDefaults.fold(
      EFFECTIVE_CONFIG_DEFAULTS,
      agent({ strict: { enabled: true, attempts: 3, wallMinutes: 20, verification: false, executionTokens: 16384 } }),
    )
    expect(folded.strict).toEqual({
      enabled: true,
      attempts: 3,
      wallMinutes: 20,
      verification: false,
      executionTokens: 16384,
    })
  })

  test("bool-or-struct harness stances split — the stance stays boolean, detail rides its own key", () => {
    // A struct folded whole into the stance slot would read truthy for `{ enabled: false }`
    // at every boolean reader (`llm.ts`'s affective gate among them) — the `{enabled:false}`
    // officer would run enabled. The split keeps the lie unrepresentable.
    const fromBool = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ introspection: false, affective: true }))
    expect(fromBool.introspection).toBe(false)
    expect(fromBool.affective).toBe(true)
    expect(fromBool.introspectionDetail).toBeUndefined()
    expect(fromBool.affectiveDetail).toBeUndefined()
    const fromStruct = AgentDefaults.fold(
      EFFECTIVE_CONFIG_DEFAULTS,
      agent({ introspection: { enabled: true, cadence: 5 }, affective: { enabled: true, temperature: 0.4 } }),
    )
    expect(fromStruct.introspection).toBe(true)
    expect(fromStruct.introspectionDetail).toEqual({ cadence: 5 })
    expect(fromStruct.affective).toBe(true)
    expect(fromStruct.affectiveDetail).toEqual({ temperature: 0.4 })
  })

  test("detail without a stance inherits the stance but keeps the detail", () => {
    const colleague = agent({ introspection: { cadence: 5 } })
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, colleague)
    expect(folded.introspection).toBeUndefined()
    expect(folded.introspectionDetail).toEqual({ cadence: 5 })
    expect(AgentDefaults.declaredBy(colleague)).toEqual(["introspectionDetail"])
  })

  test("the tool horizon and recipe delivery fold as officer data", () => {
    const folded = AgentDefaults.fold(
      EFFECTIVE_CONFIG_DEFAULTS,
      agent({
        tools: { bash: false, read: true },
        adhocTools: [{ name: "deploy", description: "Ship it", manual: "run ./ship" }],
      }),
    )
    expect(folded.tools).toEqual({ bash: false, read: true })
    expect(folded.adhocTools).toEqual([{ name: "deploy", description: "Ship it", manual: "run ./ship" }])
  })

  test("an officer that declares no delivery leaves the base alone", () => {
    const folded = AgentDefaults.fold(EFFECTIVE_CONFIG_DEFAULTS, agent({ title: "Bookkeeper" }))
    expect(folded.tools).toBeUndefined()
    expect(folded.adhocTools).toBeUndefined()
  })
})

describe("the colleague sits UNDER the folder", () => {
  // 🗑️ Three cases stood here about the FOLDER layer: that a colleague declares features the folder may
  // not influence (`ProjectDefaults.WIRED`, whose overlap the test pinned so a widened supervision rail
  // would be a deliberate act), that the colleague outranks the shipped baseline, and that a folder
  // lands its own features over the colleague's. All three were about the `novaclaw.json` tune, which is
  // retired (owner, 2026-09-16): with no folder layer the ORDER they guarded does not exist, and the
  // colleague-under-the-chain property they shared is covered by the cases below.

  test("the five restored officer toggles are real session defaults", () => {
    const folded = AgentDefaults.fold(
      EFFECTIVE_CONFIG_DEFAULTS,
      agent({ contextBudget: false, surgicalEdits: true, introspection: true, quality: true, affective: true }),
    )
    expect(folded).toMatchObject({
      contextBudget: false,
      surgicalEdits: true,
      introspection: true,
      quality: true,
      affective: true,
    })
  })
})
