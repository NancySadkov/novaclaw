import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  moreRestrictive,
  resolveConfig,
  resolveSessionConfig,
  type EffectiveConfig,
  type SessionConfig,
  type SessionLike,
} from "./config-resolve"

const DEFAULTS: EffectiveConfig = {
  type: "interactive",
  priority: 0,
  responder: "nova",
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

  test("B10 responder: defaults to nova, inherits down the chain, child can override", () => {
    expect(resolveConfig(DEFAULTS, []).responder).toBe("nova")
    // A parent under operator control → a child with no responder inherits "operator".
    expect(resolveConfig(DEFAULTS, [{ responder: "operator" }, {}]).responder).toBe("operator")
    // …but the child can hand its own thread back to nova.
    expect(resolveConfig(DEFAULTS, [{ responder: "operator" }, { responder: "nova" }]).responder).toBe("nova")
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

describe("resolveSessionConfig — the effectful parentID walk", () => {
  const runWalk = (sessionID: string, sessions: Record<string, SessionLike>) =>
    Effect.runSync(resolveSessionConfig(DEFAULTS, sessionID, (id: string) => Effect.succeed(sessions[id])))

  test("single root session resolves its own config", () =>
    expect(runWalk("root", { root: { id: "root", model: { providerID: "dgx", id: "qwen" } } }).model).toEqual({
      providerID: "dgx",
      id: "qwen",
    }))

  test("a child inherits the parent's model + overrides its agent", () => {
    const eff = runWalk("child", {
      root: { id: "root", model: { providerID: "dgx", id: "qwen" }, agent: "build" },
      child: { id: "child", parentID: "root", agent: "review" },
    })
    expect(eff.model).toEqual({ providerID: "dgx", id: "qwen" }) // inherited
    expect(eff.agent).toBe("review") // overridden
  })

  test("three-level chain resolves the nearest-defined value", () =>
    expect(
      runWalk("gc", {
        root: { id: "root", agent: "a" },
        parent: { id: "parent", parentID: "root", agent: "b" },
        gc: { id: "gc", parentID: "parent" }, // inherits agent "b"
      }).agent,
    ).toBe("b"))

  test("a missing parent stops the walk gracefully", () =>
    expect(runWalk("child", { child: { id: "child", parentID: "ghost", agent: "x" } }).agent).toBe("x"))

  test("a cyclic parentID chain terminates (guarded, does not hang)", () =>
    expect(runWalk("a", { a: { id: "a", parentID: "b" }, b: { id: "b", parentID: "a" } }).permissionMode).toBe("ask"))

  test("a child inherits the parent's systemPromptOverride through the walk", () =>
    expect(
      runWalk("child", {
        root: { id: "root", systemPromptOverride: "You are Neo." },
        child: { id: "child", parentID: "root" }, // no override of its own -> inherits
      }).systemPromptOverride,
    ).toBe("You are Neo."))

  test("a child's own systemPromptOverride wins over the parent's", () =>
    expect(
      runWalk("child", {
        root: { id: "root", systemPromptOverride: "parent prompt" },
        child: { id: "child", parentID: "root", systemPromptOverride: "child prompt" },
      }).systemPromptOverride,
    ).toBe("child prompt"))
})

describe("resolveConfig — thread type + priority (K1)", () => {
  test("defaults: interactive at priority 0", () => {
    const resolved = resolveConfig(DEFAULTS, [])
    expect(resolved.type).toBe("interactive")
    expect(resolved.priority).toBe(0)
  })

  test("a session's own type/priority override the defaults", () => {
    const resolved = resolveConfig(DEFAULTS, [{ type: "goal-oriented", priority: 5 }])
    expect(resolved.type).toBe("goal-oriented")
    expect(resolved.priority).toBe(5)
  })

  test("a child inherits the parent's type/priority when it defines none", () => {
    const resolved = resolveConfig(DEFAULTS, [{ type: "auto-prompting", priority: 3 }, {}])
    expect(resolved.type).toBe("auto-prompting")
    expect(resolved.priority).toBe(3)
  })

  test("a child's own type/priority win over the parent's", () => {
    const resolved = resolveConfig(DEFAULTS, [{ type: "auto-prompting", priority: 3 }, { type: "sub-agent", priority: 1 }])
    expect(resolved.type).toBe("sub-agent")
    expect(resolved.priority).toBe(1)
  })

  test("priority 0 on a child is a real override, not inherit", () => {
    const resolved = resolveConfig(DEFAULTS, [{ priority: 9 }, { priority: 0 }])
    expect(resolved.priority).toBe(0)
  })

  test("type/priority flow through the effectful walk", () => {
    const sessions: Record<string, SessionLike> = {
      root: { id: "root", type: "goal-oriented", priority: 7 },
      child: { id: "child", parentID: "root" },
    }
    const resolved = Effect.runSync(
      resolveSessionConfig(DEFAULTS, "child", (id) => Effect.succeed(sessions[id])),
    )
    expect(resolved).toMatchObject({ type: "goal-oriented", priority: 7 })
  })
})
