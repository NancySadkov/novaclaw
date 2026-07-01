import { describe, expect, test } from "bun:test"
import { moreRestrictive, resolveConfig, type EffectiveConfig, type SessionConfig } from "./config-resolve"

const DEFAULTS: EffectiveConfig = {
  permissionMode: "ask",
  permissionRules: [],
  introspection: false,
  affective: false,
}

describe("resolveConfig — simple fields (undefined = inherit)", () => {
  test("empty chain -> defaults verbatim", () => expect(resolveConfig(DEFAULTS, [])).toEqual(DEFAULTS))

  test("a root layer overrides defined fields, inherits the rest", () => {
    const eff = resolveConfig(DEFAULTS, [{ model: { providerID: "dgx", id: "qwen" }, affective: true }])
    expect(eff.model).toEqual({ providerID: "dgx", id: "qwen" })
    expect(eff.affective).toBe(true)
    expect(eff.introspection).toBe(false) // inherited from defaults
    expect(eff.agent).toBeUndefined() // inherited (still unset)
  })

  test("child inherits parent's override for its own undefined field", () => {
    const root: SessionConfig = { model: { providerID: "dgx", id: "qwen" }, agent: "build" }
    const child: SessionConfig = { agent: "review" } // overrides agent, inherits model
    const eff = resolveConfig(DEFAULTS, [root, child])
    expect(eff.model).toEqual({ providerID: "dgx", id: "qwen" }) // from root
    expect(eff.agent).toBe("review") // child override
  })

  test("three-level chain: nearest-defined wins", () => {
    const eff = resolveConfig(DEFAULTS, [{ agent: "a" }, { agent: "b" }, { device: "spark" }])
    expect(eff.agent).toBe("b") // grandchild didn't set agent -> nearest is level 2
    expect(eff.device).toBe("spark")
  })

  test("systemPromptOverride inherits then overrides", () => {
    expect(resolveConfig(DEFAULTS, [{ systemPromptOverride: "You are Neo." }, {}]).systemPromptOverride).toBe(
      "You are Neo.",
    )
    expect(resolveConfig(DEFAULTS, [{ systemPromptOverride: "A" }, { systemPromptOverride: "B" }]).systemPromptOverride).toBe(
      "B",
    )
  })
})

describe("resolveConfig — permission MODE narrowing (the safety invariant)", () => {
  test("root sets its mode freely (even more permissive than the default)", () =>
    expect(resolveConfig(DEFAULTS, [{ permissionMode: "yolo" }]).permissionMode).toBe("yolo"))

  test("a child CANNOT escalate past its parent", () =>
    expect(resolveConfig(DEFAULTS, [{ permissionMode: "ask" }, { permissionMode: "yolo" }]).permissionMode).toBe("ask"))

  test("a child CAN restrict below its parent (privilege self-revocation)", () =>
    expect(resolveConfig(DEFAULTS, [{ permissionMode: "bypass" }, { permissionMode: "plan" }]).permissionMode).toBe(
      "plan",
    ))

  test("a child with no mode inherits the parent's", () =>
    expect(resolveConfig(DEFAULTS, [{ permissionMode: "surgical" }, {}]).permissionMode).toBe("surgical"))

  test("narrowing is monotonic down a deep chain (yolo grandchild stays clamped)", () =>
    expect(
      resolveConfig(DEFAULTS, [{ permissionMode: "bypass" }, { permissionMode: "ask" }, { permissionMode: "yolo" }])
        .permissionMode,
    ).toBe("ask"))

  test("moreRestrictive picks the lower-capability mode", () => {
    expect(moreRestrictive("plan", "yolo")).toBe("plan")
    expect(moreRestrictive("bypass", "surgical")).toBe("surgical")
    expect(moreRestrictive("ask", "ask")).toBe("ask")
  })
})

describe("resolveConfig — permission RULES accumulate", () => {
  test("rules concatenate down the chain (a parent deny survives a child allow)", () => {
    const eff = resolveConfig(
      { ...DEFAULTS, permissionRules: [{ action: "read", resource: "*", effect: "allow" }] },
      [
        { permissionRules: [{ action: "write", resource: "/etc/*", effect: "deny" }] },
        { permissionRules: [{ action: "write", resource: "*", effect: "ask" }] },
      ],
    )
    expect(eff.permissionRules).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "write", resource: "/etc/*", effect: "deny" },
      { action: "write", resource: "*", effect: "ask" },
    ])
  })
})
