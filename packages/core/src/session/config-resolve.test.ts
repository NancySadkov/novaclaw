import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import {
  attendedRoot,
  moreRestrictive,
  narrowRootType,
  resolveConfig,
  resolveSessionConfig,
  rootAttendance,
  rootSessionType,
  UNATTENDED_CONFINED_RULES,
  unattendedStanceRules,
  type EffectiveConfig,
  type PermissionMode,
  type RootType,
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
    expect(
      resolveConfig(DEFAULTS, [{ systemPromptOverride: "A" }, { systemPromptOverride: "B" }]).systemPromptOverride,
    ).toBe("B")
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
    const resolved = Effect.runSync(resolveSessionConfig(DEFAULTS, "child", (id) => Effect.succeed(sessions[id])))
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

  test("contextBudget is a sparse Tune: absent inherits and an explicit child stance wins", () => {
    expect(resolveConfig(DEFAULTS, []).contextBudget).toBeUndefined()
    expect(resolveConfig(DEFAULTS, [{ contextBudget: false }, {}]).contextBudget).toBe(false)
    expect(resolveConfig(DEFAULTS, [{ contextBudget: false }, { contextBudget: true }]).contextBudget).toBe(true)

    const sessions: Record<string, SessionLike> = {
      root: { id: "root", contextBudget: true },
      child: { id: "child", parentID: "root" },
      override: { id: "override", parentID: "root", contextBudget: false },
    }
    const walk = (id: string) => Effect.runSync(resolveSessionConfig(DEFAULTS, id, (x) => Effect.succeed(sessions[x])))
    expect(walk("child").contextBudget).toBe(true)
    expect(walk("override").contextBudget).toBe(false)
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
    const eff = resolveConfig({ ...DEFAULTS, permissionRules: [{ action: "read", resource: "*", effect: "allow" }] }, [
      { permissionRules: [{ action: "write", resource: "/etc/*", effect: "deny" }] },
      { permissionRules: [{ action: "write", resource: "*", effect: "ask" }] },
    ])
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

describe("rootAttendance — the chain ROOT's thread type (Agent Jail P0b)", () => {
  const rootOf = (sid: string, sessions: Record<string, SessionLike>) =>
    Effect.runSync(rootAttendance(sid, (id) => Effect.succeed(sessions[id])))

  test("a bare root reports its own type; untyped root defaults to interactive", () => {
    expect(rootOf("r", { r: { id: "r", type: "goal-oriented" } })).toBe("goal-oriented")
    // A root row with no `type` is a READ we performed, not a fault: `undefined` means inherit, and
    // at the root that is the global default. It must NOT become "unknown", or the fix would
    // confine every ordinary chat — the false-fault-in-the-other-direction ruling 2 also forbids.
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

  // ── the unreadable chains (2026-07-28) ─────────────────────────────────────────────────────
  // Each of these used to answer with an ATTENDED type, which removes the confinement stance
  // entirely and, at `AgentJail.decideBash`, returns "raw". Measured before the change, verbatim:
  //   dangling parent, sub-agent row   → "sub-agent"    (attended, stance [])
  //   dangling parent, untyped row     → "interactive"  (attended, stance [])
  //   cycle of two auto-prompting rows → "interactive"  (attended, stance [])
  //   missing row (NOT a chain fault)  → "interactive"  (attended, stance []) — see below
  test("a session id that names NO row keeps the default — nothing was declared, so nothing faulted", () => {
    // The deliberate non-change, and the boundary of this fix. There is no chain to be wrong about
    // when there is no session: this is `HostExec.decide`'s `undefined` slot ("declared nothing"),
    // not its `"unknown"` slot ("declared a fault"). The seam that CAN observe the discrepancy
    // already refuses on it — `PermissionV2` fails `Session.NotFoundError` before reaching an allow
    // (pinned in `test/permission.test.ts`). Measured 2026-07-28: making this `"unknown"` fails 9 of
    // 12 `test/tool-bash.test.ts` tests, all of which drive the bash tool with no session row at
    // all — a shape only a fixture produces, and the cure is for `tool/bash.ts` to refuse an unknown
    // session, not for this walk to invent an attendance.
    expect(rootOf("nope", {})).toBe("interactive")
  })

  test("a chain that dangles at a missing parent is UNKNOWN — the deepest KNOWN layer is not evidence about the root", () => {
    // The worst shape, and the one the old code was written to produce: the surviving row says
    // "sub-agent", which `attendedRoot` reads as ATTENDED, while the root that actually decided
    // attendance is exactly the row that vanished.
    expect(rootOf("child", { child: { id: "child", parentID: "ghost", type: "sub-agent" } })).toBe("unknown")
    expect(rootOf("child", { child: { id: "child", parentID: "ghost", type: "auto-prompting" } })).toBe("unknown")
    expect(rootOf("child", { child: { id: "child", parentID: "ghost" } })).toBe("unknown")
  })

  test("a cyclic chain is UNKNOWN — a ring of unattended rows used to answer 'interactive'", () => {
    expect(rootOf("a", { a: { id: "a", parentID: "b" }, b: { id: "b", parentID: "a" } })).toBe("unknown")
    expect(
      rootOf("a", {
        a: { id: "a", parentID: "b", type: "auto-prompting" },
        b: { id: "b", parentID: "a", type: "auto-prompting" },
      }),
    ).toBe("unknown")
  })

  test("a typed store failure still PROPAGATES — it is a different fault and is not swallowed here", () => {
    // `Effect.flip`, not `Effect.either` — the latter does not exist on effect@4.0.0-beta.83 and
    // fails at RUNTIME with "args[0] is not a function", which bun's type-stripping hides until the
    // test runs. Caught here 2026-07-28 while negative-controlling this file.
    expect(Effect.runSync(rootAttendance("x", () => Effect.fail("db unreadable" as const)).pipe(Effect.flip))).toBe(
      "db unreadable",
    )
  })
})

// The whole point of the tri-state: it changes the DECISION, not just the reported value.
describe("the unreadable chain reaches the confinement DECISION, not just the report", () => {
  const decide = (sid: string, sessions: Record<string, SessionLike>, mode: PermissionMode = "bypass") => {
    const root = Effect.runSync(rootAttendance(sid, (id) => Effect.succeed(sessions[id])))
    return { root, attended: attendedRoot(root), stance: unattendedStanceRules(root, mode) }
  }

  test("each unreadable chain is not attended and DOES get the stance", () => {
    for (const [label, sid, sessions] of [
      ["dangling parent", "child", { child: { id: "child", parentID: "ghost", type: "sub-agent" } }],
      ["dangling parent, untyped", "child", { child: { id: "child", parentID: "ghost" } }],
      ["cycle", "a", { a: { id: "a", parentID: "b" }, b: { id: "b", parentID: "a" } }],
      [
        "cycle of unattended rows",
        "a",
        {
          a: { id: "a", parentID: "b", type: "auto-prompting" },
          b: { id: "b", parentID: "a", type: "auto-prompting" },
        },
      ],
    ] as const) {
      const { root, attended, stance } = decide(sid, sessions as Record<string, SessionLike>)
      expect(root, label).toBe("unknown")
      expect(attended, label).toBe(false)
      expect(stance, label).toEqual(UNATTENDED_CONFINED_RULES)
    }
  })

  // NEGATIVE CONTROL — without this the block above could be produced by a change that confines
  // EVERYTHING. A chain read end to end to an interactive root is untouched: still attended, still
  // no stance. (This is also the exact answer the three cases above used to give.)
  test("NEGATIVE CONTROL: a healthy attended chain is untouched — still attended, still no stance", () => {
    const healthy = decide("child", {
      root: { id: "root", type: "interactive" },
      child: { id: "child", parentID: "root", type: "sub-agent" },
    })
    expect(healthy).toEqual({ root: "interactive", attended: true, stance: [] })
    // …and the value the walk used to return for a broken chain would still buy exactly that.
    expect(attendedRoot("interactive")).toBe(true)
    expect(attendedRoot("sub-agent")).toBe(true)
    expect(unattendedStanceRules("interactive", "bypass")).toEqual([])
  })

  // `yolo` stays the ONE deliberate way out, and it is not reachable for a spawned child
  // (`moreRestrictive` clamps it), so this does not open a bypass.
  test("an unreadable chain under yolo still opts out — the escape hatch is unchanged", () =>
    expect(unattendedStanceRules("unknown", "yolo")).toEqual([]))
})

describe("narrowRootType — the ONE collapse point for the root tri-state", () => {
  const KNOWN: SessionType[] = ["interactive", "sub-agent", "auto-prompting", "goal-oriented"]

  test("it is the identity on every readable answer — nothing else is reinterpreted", () => {
    for (const type of KNOWN) expect(narrowRootType(type)).toBe(type)
  })

  test("an unreadable chain narrows to an UNATTENDED type, so a SessionType-only consumer contains it", () => {
    const narrowed = narrowRootType("unknown")
    // Stated as the DECISION, not as the constant: flipping `UNREADABLE_CHAIN_ROOT_TYPE` back to
    // "interactive" (what the walk used to return) fails all three of these at once. That is what
    // keeps `tool/bash.ts` and the Strict runner — which still speak plain `SessionType` through
    // `HostExec` — fail-closed without a single edit to either file.
    expect(KNOWN).toContain(narrowed)
    expect(attendedRoot(narrowed)).toBe(false)
    expect(unattendedStanceRules(narrowed, "bypass")).toEqual(UNATTENDED_CONFINED_RULES)
  })

  test("attendedRoot and the narrowing can never disagree — there is no second collapse", () => {
    // `attendedRoot` is DEFINED through `narrowRootType`; this is the mechanical version of that
    // claim, so a future edit that gives the predicate its own opinion about "unknown" fails here.
    for (const value of [...KNOWN, "unknown"] as RootType[])
      expect(attendedRoot(value), value).toBe(attendedRoot(narrowRootType(value)))
  })

  test("the narrow adapter `rootSessionType` routes through it — every legacy call site fail-closes", () => {
    const via = (sid: string, sessions: Record<string, SessionLike>) =>
      Effect.runSync(rootSessionType(sid, (id) => Effect.succeed(sessions[id])))
    // The chain faults, as `tool/bash.ts` and the Strict runner now see them: a dangling parent and
    // a cycle no longer buy "raw" from `AgentJail.decideBash`, with no edit to either file.
    expect(attendedRoot(via("child", { child: { id: "child", parentID: "ghost", type: "sub-agent" } }))).toBe(false)
    expect(attendedRoot(via("a", { a: { id: "a", parentID: "b" }, b: { id: "b", parentID: "a" } }))).toBe(false)
    // NEGATIVE CONTROL — a healthy chain still passes through untouched, so the adapter is not
    // simply hardcoding "unattended" for everything…
    expect(via("r", { r: { id: "r", type: "interactive" } })).toBe("interactive")
    expect(attendedRoot(via("r", { r: { id: "r", type: "interactive" } }))).toBe(true)
    // …and neither is the no-such-session case, which is the documented boundary of this fix.
    expect(attendedRoot(via("nope", {}))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SHRINK-ONLY LEDGER — who is allowed to hold the three-valued root answer.
//
// The TYPE already stops a caller folding `RootType` into a `SessionType` slot silently (that is
// ruling 1's mechanical edge). What a type cannot stop is a second collapse point appearing in a
// new file, or `permission.ts` quietly reverting to the collapsed adapter and losing the honest
// denial reason. This ledger is that ratchet: it fails on a file that reaches for the tri-state
// without an entry, AND on an entry whose file has stopped doing so. Same shape as
// `host-exec.test.ts`'s `Hostility` ledger — deliberately, because it is the same defect class.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the root tri-state has ONE collapse point (shrink-only ledger)", () => {
  const SRC = path.resolve(import.meta.dir, "..")
  const SELF = path.resolve(import.meta.dir, "config-resolve.test.ts")

  /** Comments discuss the old boolean-ish world freely; only CODE is swept. */
  const stripComments = (text: string) =>
    text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1")

  const SHAPES: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
    { pattern: /\brootAttendance\s*\(/, what: "reads the three-valued root answer" },
    { pattern: /\bRootType\b/, what: "names the three-valued root type" },
    { pattern: /\bnarrowRootType\s*\(/, what: "collapses the three-valued root answer" },
  ]

  const shapesIn = (text: string) => SHAPES.filter((shape) => shape.pattern.test(text)).map((shape) => shape.what)

  const collect = (dir: string, out: Array<{ name: string; text: string }> = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "gen") continue
        collect(full, out)
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        // Production code only. A test file naming the type is not a shipped decision — and
        // sweeping them would put this very file, and every future test of the tri-state, in the
        // ledger, which turns the ratchet into noise.
        if (full === SELF || entry.name.endsWith(".test.ts")) continue
        out.push({
          name: path.relative(SRC, full).replaceAll("\\", "/"),
          text: stripComments(fs.readFileSync(full, "utf8")),
        })
      }
    }
    return out
  }
  const sources = collect(SRC)

  /** Every file allowed to hold the tri-state, and why. */
  const LEDGER = new Map<string, string>([
    [
      "session/config-resolve.ts",
      "The walk that produces it, and the ONE collapse point: `narrowRootType` is the single place " +
        '`"unknown"` becomes anything else, `attendedRoot` is defined through it, and ' +
        "`rootSessionType` is the adapter that carries the contained answer to the `SessionType`-only " +
        "consumers (HostExec / AgentJail).",
    ],
    [
      "permission.ts",
      "The one consumer entitled to NAME the fault: it reads the tri-state so a stance denial can " +
        "report `chain-unreadable` instead of claiming the session is unattended (ruling 2). It " +
        "decides containment through `unattendedStanceRules`/`attendedRoot` and never folds the " +
        "value itself.",
    ],
    [
      "tool/permission.ts",
      "Auto mode's tool, and it READS the tri-state without folding it: `attendedRoot(rootType)` " +
        'decides whether a self-grant is capped at `bypass`, and `"unknown"` takes the restrictive ' +
        "arm through that same helper. Entitled because the alternative is worse — a self-managing " +
        "agent on a chain we could not read is exactly the case that must NOT reach `yolo`, and a " +
        "two-valued read here would answer `attended` for an unreadable chain (the dangling-parent " +
        "shape `rootSessionType` was fixed for). It never calls `narrowRootType`; the collapse stays " +
        "in `config-resolve.ts`.",
    ],
  ])

  test("the sweep actually has the package to look at", () => {
    expect(sources.length).toBeGreaterThan(200)
    const names = new Set(sources.map((file) => file.name))
    for (const name of ["session/config-resolve.ts", "permission.ts", "tool/bash.ts", "session/runner/llm.ts"])
      expect(names, `${name} is not in the sweep`).toContain(name)
  })

  test("no unledgered file holds the three-valued root answer", () => {
    const offenders = sources
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = shapesIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join(", ")}`]
      })
      .sort()
    // A new consumer takes `rootSessionType` (already contained) or earns a ledger entry saying
    // what it does with "unknown". It does not get to invent a second answer to the question.
    expect(offenders).toEqual([])
  })

  test("the ledger can only SHRINK — an entry that no longer applies must be dropped", () => {
    const stale: string[] = []
    for (const name of LEDGER.keys()) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) stale.push(`${name} (no longer exists — drop the ledger entry)`)
      else if (shapesIn(file.text).length === 0) stale.push(`${name} (no longer holds it — drop the ledger entry)`)
    }
    // ⚠️ This is also what catches `permission.ts` sliding back to the collapsed adapter: lose the
    // tri-state there and the entry goes stale, which fails rather than silently losing the reason.
    expect(stale).toEqual([])
  })

  test("the guard bites, and stays silent on the correct shapes (negative control)", () => {
    expect(shapesIn(`const root = yield* rootAttendance(id, get)`)).toContain("reads the three-valued root answer")
    expect(shapesIn(`readonly rootType?: RootType`)).toContain("names the three-valued root type")
    expect(shapesIn(`HostExec.decide({ rootType: narrowRootType(root) })`)).toContain(
      "collapses the three-valued root answer",
    )
    // …and the shapes a normal consumer uses must NOT fire, or every existing call site lands in
    // the ledger and the ratchet becomes noise.
    expect(shapesIn(`const rootType = yield* rootSessionType(sessionID, get)`)).toEqual([])
    expect(shapesIn(`if (!AgentJail.attendedRoot(rootType)) steer(nudge)`)).toEqual([])
    expect(shapesIn(`readonly rootType?: SessionType`)).toEqual([])
    // A file that only TALKS about it in a comment is code-clean, because comments are stripped.
    expect(shapesIn(stripComments(`// rootAttendance() returns RootType\nconst x = 1`))).toEqual([])
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
    const resolved = resolveConfig(DEFAULTS, [
      { type: "auto-prompting", priority: 3 },
      { type: "sub-agent", priority: 1 },
    ])
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
    const resolved = Effect.runSync(resolveSessionConfig(DEFAULTS, "child", (id) => Effect.succeed(sessions[id])))
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

  // The stance answers destructive WRITES only. Reads are not a permission-mode capability.
  test("an UNATTENDED root below yolo hard-denies only the WRITE class", () => {
    for (const type of UNATTENDED)
      for (const mode of BELOW_YOLO) expect(unattendedStanceRules(type, mode)).toEqual(UNATTENDED_CONFINED_RULES)
    expect(UNATTENDED_CONFINED_RULES).toEqual([{ action: "external_directory_write", resource: "*", effect: "deny" }])
  })

  test("the stance names NOTHING inside the folder — in-folder work is untouched", () => {
    const actions = UNATTENDED_CONFINED_RULES.map((rule) => rule.action)
    for (const action of ["read", "edit", "write", "create", "trash", "bash"]) expect(actions).not.toContain(action)
  })

  test("yolo is the one way out of the external-write stance", () => {
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
