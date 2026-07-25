import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  attendedRoot,
  moreRestrictive,
  PARANOID_READ_RULES,
  resolveConfig,
  resolveSessionConfig,
  rootSessionType,
  UNATTENDED_CONFINED_RULES,
  unattendedStanceRules,
  type EffectiveConfig,
  type PermissionMode,
  type SessionConfig,
  type SessionLike,
  type SessionType,
} from "./config-resolve"

const DEFAULTS: EffectiveConfig = {
  type: "interactive",
  priority: 0,
  responder: "nova",
  permissionMode: "ask",
  permissionRules: [],
}

describe("resolveConfig — simple fields (undefined = inherit)", () => {
  test("empty chain -> defaults verbatim", () => expect(resolveConfig(DEFAULTS, [])).toEqual(DEFAULTS))

  test("a root layer overrides defined fields, inherits the rest", () => {
    const eff = resolveConfig(DEFAULTS, [{ model: { providerID: "dgx", id: "qwen" }, affective: true }])
    expect(eff.model).toEqual({ providerID: "dgx", id: "qwen" })
    expect(eff.affective).toBe(true)
    expect(eff.introspection).toBeUndefined() // no per-session stance — runner falls back to global
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

  test("feature toggles (T1): tri-state — child inherits parent's stance, own stance wins, explicit false is real", () => {
    // No stance anywhere → undefined (the runner falls back to the global config block).
    expect(resolveConfig(DEFAULTS, [{}]).quality).toBeUndefined()
    // A parent's stance flows to a stance-less child.
    expect(resolveConfig(DEFAULTS, [{ quality: true }, {}]).quality).toBe(true)
    expect(resolveConfig(DEFAULTS, [{ introspection: true }, {}]).introspection).toBe(true)
    // The child's own stance wins — including an explicit FALSE over a parent's true.
    expect(resolveConfig(DEFAULTS, [{ quality: true }, { quality: false }]).quality).toBe(false)
    expect(resolveConfig(DEFAULTS, [{ affective: true }, { affective: false }]).affective).toBe(false)
  })

  test("feature toggles flow through the effectful walk (session rows carry them)", () => {
    const sessions: Record<string, SessionLike> = {
      root: { id: "root", quality: true, introspection: true, affective: true },
      child: { id: "child", parentID: "root", introspection: false },
    }
    const resolved = Effect.runSync(
      resolveSessionConfig(DEFAULTS, "child", (id) => Effect.succeed(sessions[id])),
    )
    expect(resolved.quality).toBe(true) // inherited
    expect(resolved.affective).toBe(true) // inherited
    expect(resolved.introspection).toBe(false) // the child's explicit off wins
  })

  // The thinking-budget override (the composer's Tuning switch). Tri-state like the other features, with
  // one difference that matters: there is no global `{ enabled }` block for it, so ABSENT must stay absent
  // all the way to the runner, which reads `config.thinkingBudget ?? true`. If the walk ever defaulted it
  // to false, every chat would silently lose its reasoning cap.
  test("thinkingBudget is tri-state: absent inherits, explicit false wins, and it never defaults to false", () => {
    expect(resolveConfig(DEFAULTS, []).thinkingBudget).toBeUndefined()
    expect(resolveConfig(DEFAULTS, [{}, {}]).thinkingBudget).toBeUndefined()
    // A chat that turns the cap OFF, and a child that turns it back ON.
    expect(resolveConfig(DEFAULTS, [{ thinkingBudget: false }]).thinkingBudget).toBe(false)
    expect(resolveConfig(DEFAULTS, [{ thinkingBudget: false }, {}]).thinkingBudget).toBe(false)
    expect(resolveConfig(DEFAULTS, [{ thinkingBudget: false }, { thinkingBudget: true }]).thinkingBudget).toBe(true)
  })

  test("thinkingBudget flows through the effectful walk off the session row", () => {
    const sessions: Record<string, SessionLike> = {
      root: { id: "root", thinkingBudget: false },
      child: { id: "child", parentID: "root" },
      loud: { id: "loud", parentID: "root", thinkingBudget: true },
    }
    const walk = (id: string) => Effect.runSync(resolveSessionConfig(DEFAULTS, id, (x) => Effect.succeed(sessions[x])))
    expect(walk("child").thinkingBudget).toBe(false) // inherited from the root
    expect(walk("loud").thinkingBudget).toBe(true) // the child re-enables its own cap
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

describe("rootSessionType — the chain ROOT's thread type (Agent Jail P0b)", () => {
  const rootOf = (sid: string, sessions: Record<string, SessionLike>) =>
    Effect.runSync(rootSessionType(sid, (id) => Effect.succeed(sessions[id])))

  test("a bare root reports its own type; untyped root defaults to interactive", () => {
    expect(rootOf("r", { r: { id: "r", type: "goal-oriented" } })).toBe("goal-oriented")
    expect(rootOf("r", { r: { id: "r" } })).toBe("interactive")
  })

  test("a sub-agent under a goal root is UNATTENDED (root type wins, not the target's)", () =>
    expect(
      rootOf("child", {
        root: { id: "root", type: "goal-oriented" },
        child: { id: "child", parentID: "root", type: "sub-agent" },
      }),
    ).toBe("goal-oriented"))

  test("a sub-agent under an interactive root reports the interactive root", () =>
    expect(
      rootOf("child", {
        root: { id: "root", type: "interactive" },
        child: { id: "child", parentID: "root", type: "sub-agent" },
      }),
    ).toBe("interactive"))

  test("a chain broken mid-walk reports the highest KNOWN layer's type", () =>
    expect(rootOf("child", { child: { id: "child", parentID: "ghost", type: "auto-prompting" } })).toBe(
      "auto-prompting",
    ))

  test("a missing session and a cyclic chain both fail OPEN to interactive", () => {
    expect(rootOf("nope", {})).toBe("interactive")
    expect(rootOf("a", { a: { id: "a", parentID: "b" }, b: { id: "b", parentID: "a" } })).toBe("interactive")
  })
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

// The unattended confinement stance (deny-fast). "Switchable" without a new mode or a new column:
// the switch is the pair that already exists — the chain ROOT's thread type (attendance) and the
// resolved permission MODE (`yolo` = the deliberate way out).
describe("unattendedStanceRules — the unattended confinement stance", () => {
  const ATTENDED: SessionType[] = ["interactive", "sub-agent"]
  const UNATTENDED: SessionType[] = ["auto-prompting", "goal-oriented"]
  const BELOW_YOLO: PermissionMode[] = ["plan", "ask", "surgical", "bypass"]

  test("attendedRoot: only interactive + sub-agent have someone to answer", () => {
    for (const type of ATTENDED) expect(attendedRoot(type)).toBe(true)
    for (const type of UNATTENDED) expect(attendedRoot(type)).toBe(false)
  })

  test("an ATTENDED root never gets the stance — asks still reach the human, in every mode", () => {
    for (const type of ATTENDED)
      for (const mode of [...BELOW_YOLO, "yolo" as const]) expect(unattendedStanceRules(type, mode)).toEqual([])
  })

  // Owner call (2026-07-25): the fear these rules answer is a destructive WRITE, not a leaked read.
  // Reading outside the folder is ordinary work (a toolchain, an SDK, a header), so it is confined only
  // for a user who deliberately turns Paranoid on.
  test("an UNATTENDED root below yolo hard-denies the WRITE class by default", () => {
    for (const type of UNATTENDED)
      for (const mode of BELOW_YOLO) expect(unattendedStanceRules(type, mode)).toEqual(UNATTENDED_CONFINED_RULES)
    expect(UNATTENDED_CONFINED_RULES).toEqual([{ action: "external_directory_write", resource: "*", effect: "deny" }])
  })

  test("PARANOID adds the read class on top — and only then", () => {
    for (const type of UNATTENDED)
      for (const mode of BELOW_YOLO) {
        const rules = unattendedStanceRules(type, mode, true)
        expect(rules).toEqual([...UNATTENDED_CONFINED_RULES, ...PARANOID_READ_RULES])
        expect(rules.filter((rule) => rule.action === "external_directory_read")).toHaveLength(1)
      }
    // Paranoid never resurrects the stance for an attended root, nor past yolo.
    for (const type of ATTENDED)
      for (const mode of BELOW_YOLO) expect(unattendedStanceRules(type, mode, true)).toEqual([])
    for (const type of UNATTENDED) expect(unattendedStanceRules(type, "yolo", true)).toEqual([])
  })

  test("the stance names NOTHING inside the folder — in-folder work is untouched", () => {
    const actions = UNATTENDED_CONFINED_RULES.map((rule) => rule.action)
    for (const action of ["read", "edit", "write", "create", "trash", "bash"]) expect(actions).not.toContain(action)
  })

  test("yolo is the one way out (the mode that already ALLOWS the external classes)", () => {
    for (const type of UNATTENDED) expect(unattendedStanceRules(type, "yolo")).toEqual([])
  })

  // The composition that makes the stance non-escapable: unattendedness is the ROOT's property, so
  // a child cannot re-declare itself attended, and `yolo` — the only exit — is unreachable for any
  // non-root layer because permissionMode NARROWS.
  test("a spawned child cannot escape the stance: root type wins and yolo is clamped away", () => {
    const sessions: Record<string, SessionLike> = {
      root: { id: "root", type: "goal-oriented", permissionMode: "bypass" },
      child: { id: "child", parentID: "root", type: "interactive", permissionMode: "yolo" },
    }
    const get = (id: string) => Effect.succeed(sessions[id])
    const rootType = Effect.runSync(rootSessionType("child", get))
    const mode = Effect.runSync(resolveSessionConfig(DEFAULTS, "child", get)).permissionMode
    expect(rootType).toBe("goal-oriented") // the child's "interactive" does not buy attendance
    expect(mode).toBe("bypass") // moreRestrictive clamped the child's yolo bid
    expect(unattendedStanceRules(rootType, mode)).toEqual(UNATTENDED_CONFINED_RULES)
  })

  test("a ROOT that explicitly chooses yolo opts its whole subtree out (and a child stays out)", () => {
    const sessions: Record<string, SessionLike> = {
      root: { id: "root", type: "goal-oriented", permissionMode: "yolo" },
      child: { id: "child", parentID: "root" },
    }
    const get = (id: string) => Effect.succeed(sessions[id])
    const rootType = Effect.runSync(rootSessionType("child", get))
    const mode = Effect.runSync(resolveSessionConfig(DEFAULTS, "child", get)).permissionMode
    expect(unattendedStanceRules(rootType, mode)).toEqual([])
  })

  test("a child under a yolo root that narrows itself falls BACK INTO the stance", () => {
    const sessions: Record<string, SessionLike> = {
      root: { id: "root", type: "auto-prompting", permissionMode: "yolo" },
      child: { id: "child", parentID: "root", permissionMode: "bypass" },
    }
    const get = (id: string) => Effect.succeed(sessions[id])
    const mode = Effect.runSync(resolveSessionConfig(DEFAULTS, "child", get)).permissionMode
    expect(mode).toBe("bypass")
    expect(unattendedStanceRules(Effect.runSync(rootSessionType("child", get)), mode)).toEqual(
      UNATTENDED_CONFINED_RULES,
    )
  })

  // The stance is a RULE overlay, so it obeys the deny-wins evaluator: an accumulated rule set can
  // only add restrictions, and an agent's allow-all cannot outrank the stance (the evaluator checks
  // it in its own HARD arm — covered end-to-end in test/permission.test.ts).
  test("stance rules survive rule ACCUMULATION down the chain", () => {
    const resolved = resolveConfig(DEFAULTS, [
      { permissionRules: [...UNATTENDED_CONFINED_RULES] },
      { permissionRules: [{ action: "external_directory_write", resource: "*", effect: "allow" }] },
    ])
    // Accumulation keeps both; the deny is still present for the deny-wins evaluator to find.
    expect(resolved.permissionRules).toContainEqual({
      action: "external_directory_write",
      resource: "*",
      effect: "deny",
    })
  })
})
