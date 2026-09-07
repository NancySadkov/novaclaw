import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import nodePath from "node:path"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { ConfigPermission } from "@novaclaw/core/config/permission"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Global } from "@novaclaw/core/global"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { AbsolutePath } from "@novaclaw/core/schema"
import { EFFECTIVE_CONFIG_DEFAULTS, MODE_RULES } from "@novaclaw/core/session/config-resolve"
import { Wildcard } from "@novaclaw/core/util/wildcard"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"
import { stripComments } from "./lib/source-scan"

// ─────────────────────────────────────────────────────────────────────────────
// v0.2.0 B4c — the permission baseline is an ALLOWLIST, and this file is the ratchet that keeps it
// one. The invariant it protects is the exact shape ruling 1 exists for: re-adding
// `{ action: "*", resource: "*", effect: "allow" }` to `plugin/agent.ts` compiles, typechecks and
// passes every other suite in the tree, while quietly restoring a baseline that answers ALLOW for
// every gate nobody wrote a later rule for.
//
// ⚠️ It reads the REAL agents the plugin builds, never a hand-copied fixture. Four files in this
// repo carried their own literal of the old baseline; a fixture cannot notice that the thing it
// mirrors has changed, which is why the check that matters runs the plugin.
// ─────────────────────────────────────────────────────────────────────────────

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

/** Build every built-in agent exactly as an instance does, and hand back their rulesets by id. */
const builtinAgents = Effect.gen(function* () {
  const agent = yield* AgentV2.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
    Effect.provideService(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
    ),
  )
  return new Map((yield* agent.all()).map((item) => [String(item.id), item.permissions as PermissionV2.Ruleset]))
})

/**
 * The evaluator's own composition for the DEFAULT posture, reproduced in the order
 * `permission.ts`'s `evaluateInput` builds it: the live read baseline, then the agent's configured
 * rules, then the resolved mode's overlay. Attended + no Tuning switches, so the stance and
 * feature arms are empty — the case a fresh install runs in.
 */
const effectFor = (agentRules: PermissionV2.Ruleset, action: string, resource = "src/x.ts") =>
  PermissionV2.evaluate(action, resource, [
    { action: "external_directory_read", resource: "*", effect: "allow" },
    ...agentRules,
    ...MODE_RULES[EFFECTIVE_CONFIG_DEFAULTS.permissionMode],
  ]).effect

// ─────────────────────────────────────────────────────────────────────────────
// The authored permission dict is an OPEN namespace, and that is B4c's premise rather than laxity.
//
// `config/permission.ts` names its known keys for generated docs/types but keeps a rest record, so an
// action it never heard of is still accepted. It HAS to be: an action can be an MCP tool's own name,
// or one a model invented at runtime via `tool/define-tool.ts` — the two shapes the ad-hoc-tool tests
// above are about. Retiring `glob`/`grep`/`list` from the named list on 2026-07-30 must therefore not
// have closed the door, and the flip side (a retired key still parses, and now names an action
// nothing spends) is the behaviour change recorded at that file.
// ─────────────────────────────────────────────────────────────────────────────
describe("the authored permission dict stays an open namespace", () => {
  test("an action no named key mentions is accepted and lowers to a rule, in authored order", () => {
    // The TYPE annotation is half the check: it fails to compile if the rest record ever goes away,
    // which no runtime assertion could notice. Legacy callers pass exactly these shapes
    // (`packages/novaclaw/src/agent/agent.ts`'s `Permission.fromConfig({ glob: "allow", … })`).
    const authored: ConfigPermission.Info = {
      explore: "deny",
      my_deploy_tool: "ask",
      mcp_tracker_create_issue: { "*": "deny" },
      // Retired, still accepted — an open namespace cannot single a name out — and still lowered.
      // It simply names an action nothing spends now, which is why the change is owed a release note
      // rather than a mechanical rejection. See `src/config/permission.ts`.
      glob: "deny",
    }
    expect(ConfigPermission.ruleset(authored)).toEqual([
      { action: "explore", resource: "*", effect: "deny" },
      { action: "my_deploy_tool", resource: "*", effect: "ask" },
      { action: "mcp_tracker_create_issue", resource: "*", effect: "deny" },
      { action: "glob", resource: "*", effect: "deny" },
    ])
  })
})

describe("AMBIENT_SAFE_BASELINE — the compiled floor (B4c)", () => {
  test("membership is an explicit ledger — changing it is an edit here, never a side effect", () => {
    // A MEMBERSHIP ledger, not a shrink-only one: this list may legitimately need to grow (a future
    // ambient-safe action) or shrink (one of these turns out to egress), and both directions must
    // be a deliberate edit rather than something a refactor can do quietly. `webfetch` and `js` are
    // named product-default exceptions (owner, 2026-08-04); `websearch` joined them 2026-09-03 as
    // `webfetch`'s weaker sibling, after a live build refused an ordinary factual question. Their
    // independent hard boundaries are documented beside the constant rather than disguised as
    // ambient safety.
    expect(PermissionV2.AMBIENT_SAFE_BASELINE.map((rule) => rule.action)).toEqual([
      "read",
      "explore",
      "todowrite",
      "resource_status",
      "webfetch",
      "js",
      "websearch",
    ])
    // Every rule is an unconditional allow on `*` — the floor is a floor, not a pattern game.
    expect(PermissionV2.AMBIENT_SAFE_BASELINE.every((rule) => rule.resource === "*" && rule.effect === "allow")).toBe(
      true,
    )
    // ...and the floor itself is not the thing it replaced.
    expect(PermissionV2.catchAllAllowRules(PermissionV2.AMBIENT_SAFE_BASELINE)).toEqual([])
  })

  test("NEGATIVE CONTROL: `catchAllAllowRules` actually recognises the shape it is hunting", () => {
    // A predicate that never matches would make every assertion below vacuously green.
    const withCatchAll: PermissionV2.Ruleset = [
      ...PermissionV2.AMBIENT_SAFE_BASELINE,
      { action: "*", resource: "*", effect: "allow" },
    ]
    expect(PermissionV2.catchAllAllowRules(withCatchAll)).toEqual([{ action: "*", resource: "*", effect: "allow" }])
    // ...and it is narrow: a catch-all DENY and a wildcard-action allow scoped to one resource are
    // both legitimate and must not trip it (`missingAgentPermissions`, and the salvage backstop in
    // `settings-config-seed.ts`, are exactly those two shapes).
    expect(
      PermissionV2.catchAllAllowRules([
        { action: "*", resource: "*", effect: "deny" },
        { action: "*", resource: "*", effect: "ask" },
        { action: "*", resource: "src/*", effect: "allow" },
      ]),
    ).toEqual([])
  })
})

describe("the built-in agents the plugin actually builds", () => {
  it.effect("NO built-in agent's ruleset contains a catch-all allow", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      // The full set, asserted by name so a NEW built-in agent cannot join without being looked at.
      expect([...agents.keys()].sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        /**
         * The SERVICE agents (2026-08-28). The messenger console and the recipe cook used to create
         * sessions with NO agent at all — rows belonging to nobody, on no roster, reachable from
         * nowhere. They own that work now, so a chat a subsystem starts can be named and pointed at.
         *
         * ⚠️ Held to the SAME floor as every other built-in, which is what the loop below checks:
         * owning a subsystem's chats grants no ambient authority over what may be run.
         */
        "messenger",
        // The CEO (AGENTS.md — the structural metaphor). Same ruleset as `build` plus the two
        // interactive grants: Nova talks to the user and routes work, it does not carry authority
        // its officers lack.
        "nova",
        "plan",
        "recipe",
        "summary",
        "title",
      ])
      for (const [id, rules] of agents) {
        expect({ id, catchAll: PermissionV2.catchAllAllowRules(rules) }).toEqual({ id, catchAll: [] })
      }
    }),
  )

  it.effect("the ambient-safe floor is present and effective on the default agent", () =>
    Effect.gen(function* () {
      const build = (yield* builtinAgents).get("build")!
      for (const action of ["read", "explore", "todowrite", "resource_status"])
        expect(effectFor(build, action)).toBe("allow")
      // Filenames do not create hidden read prompts. Users can still author an explicit deny rule.
      expect(effectFor(build, "read", "packages/core/.env")).toBe("allow")
      expect(effectFor(build, "read", ".env.local")).toBe("allow")
      expect(effectFor(build, "read", ".env.example")).toBe("allow")
    }),
  )

  it.effect("only the governing agent may hand work to a colleague — and only it pays for the tool", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      // 🔴 This is a PROMPT-COST assertion as much as a permission one. `ToolRegistry.materialize`
      // withdraws a wholly-denied tool from the horizon instead of advertising it and refusing, so
      // `deny` here is what keeps `colleague`'s 2,078 resident bytes (measured 2026-08-21,
      // `location-layer.test.ts`) out of every ordinary session's prompt. If this flips to `ask`,
      // nothing refuses — but every agent starts paying for a tool it may not use.
      for (const id of ["build", "plan", "explore", "general", "summary", "title", "compaction"])
        expect({ id, effect: effectFor(agents.get(id)!, "colleague") }).toEqual({ id, effect: "deny" })
      expect(effectFor(agents.get("nova")!, "colleague")).toBe("allow")
    }),
  )

  it.effect("an OFFICER may staff itself, and only itself — spawn is granted on `inherit`, never on `*`", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      // 🔴 The owner's metaphor: *"top level executive agents … spawn the nameless sub-agents"*. Until
      // 2026-08-22 nobody could — `spawn` is absent from the ambient baseline, so it fell to `ask`,
      // and asking was removed, so every ask denies. The capability was gone rather than gated.
      expect(effectFor(agents.get("nova")!, "spawn", "inherit")).toBe("allow")

      // ⚠️ THE SAFETY CLAIM, asserted rather than described. `inherit` means the child runs as THIS
      // agent under THIS ruleset, so the grant creates a session and not one unit of authority.
      // Spawning as a NAMED agent is the one form that can widen — a narrow colleague reaching for a
      // broad one — and it must keep falling through. If this ever reads "allow", the org chart has
      // stopped being a permission structure.
      expect(effectFor(agents.get("nova")!, "spawn", "build")).toBe("ask")
      expect(effectFor(agents.get("nova")!, "spawn", "*")).toBe("ask")

      // The machinery a person drives is not an officer and does not staff itself. ⚠️ Unlike
      // `colleague`, the floor adds no DENY for them — it simply grants nothing, so spawn keeps the
      // verdict it had before officers were granted anything: `ask`, which the assert path refuses.
      // A `*` deny would additionally take the tool off their horizon, and would also take it off
      // `build` — the agent a person drives — which is a product change, not this one's.
      // `agent-floor-horizon.test.ts` drives that distinction.
      for (const id of ["build", "plan", "general"])
        expect({ id, effect: effectFor(agents.get(id)!, "spawn", "inherit") }).toEqual({ id, effect: "ask" })
      // ⚠️ `explore` answers DENY rather than `ask`, and the difference is its own and pre-existing:
      // it opens with a catch-all `{ *, *, deny }` and re-grants exactly the search pair, because a
      // read-only search agent's floor is "nothing unless named". Folding it into the loop above
      // would have hidden which agents are silent-by-absence and which are denied on purpose.
      expect(effectFor(agents.get("explore")!, "spawn", "inherit")).toBe("deny")
    }),
  )

  it.effect("a DEFAULT install is unchanged for the mutation/exec cluster — the mode grants it now", () =>
    Effect.gen(function* () {
      const build = (yield* builtinAgents).get("build")!
      // These five are absent from the floor on purpose: `MODE_RULES.bypass` (the shipped default
      // mode) allows them, so inverting the baseline did not make a fresh install ask about edits.
      for (const action of ["edit", "write", "create", "trash", "bash"]) expect(effectFor(build, action)).toBe("allow")
      // ...and the posture is now load-bearing rather than decorative: under Analyze the same
      // actions are refused, which was already true, and under Ask they are consent-gated.
      const under = (mode: keyof typeof MODE_RULES, action: string) =>
        PermissionV2.evaluate(action, "src/x.ts", [...build, ...MODE_RULES[mode]]).effect
      expect(under("plan", "edit")).toBe("deny")
      expect(under("ask", "edit")).toBe("ask")
    }),
  )

  it.effect("every gate the catch-all used to grant itself now ASKS on the default agent", () =>
    Effect.gen(function* () {
      const build = (yield* builtinAgents).get("build")!
      // The list the v0.2.0 ledger names, plus the two shapes no compiled rule can ever mention:
      // an MCP tool (its action IS the remote tool's name) and an ad-hoc tool a model invents at
      // runtime via `tool/define-tool.ts`. Those two are why growing `MODE_RULES` could not fix it.
      const wasSilentlyAllowed = [
        "spawn",
        "kb",
        "skill",
        "revert",
        "provision",
        "define_tool",
        "register-app",
        "messenger.send",
        "messenger.connect",
        "messenger.moderate",
        "mcp_tracker_create_issue",
        "my_deploy_tool",
      ]
      for (const action of wasSilentlyAllowed)
        expect({ action, effect: effectFor(build, action) }).toEqual({
          action,
          effect: "ask",
        })
    }),
  )

  it.effect("web fetch, web search and inline JavaScript are available by default", () =>
    Effect.gen(function* () {
      const build = (yield* builtinAgents).get("build")!
      expect(effectFor(build, "webfetch", "https://example.com/")).toBe("allow")
      expect(effectFor(build, "js", "1 + 1")).toBe("allow")
      // 🔴 The reported defect: this was "deny" on a default install, so "what is the current price
      // of gold" came back as a permission refusal. `webfetch` above is the strictly more powerful
      // egress and was already allowed.
      expect(effectFor(build, "websearch", "price of gold")).toBe("allow")
    }),
  )

  it.effect("NEGATIVE CONTROL: put the catch-all back and those gates silently allow again", () =>
    Effect.gen(function* () {
      // The assertion above measures the BASELINE and nothing else — restore the one rule B4c
      // removed, in the position it used to hold, and every gate reverts to granting itself. This
      // is the regression the check at the top of this describe block is there to catch.
      const build = (yield* builtinAgents).get("build")!
      const preB4c: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "allow" }, ...build]
      for (const action of ["js", "spawn", "skill", "webfetch", "define_tool", "messenger.send", "my_deploy_tool"])
        expect({ action, effect: effectFor(preB4c, action) }).toEqual({ action, effect: "allow" })
      expect(PermissionV2.catchAllAllowRules(preB4c)).toHaveLength(1)
    }),
  )

  it.effect("a mode overlay is now a BOUNDARY for the ad-hoc tool it can never name", () =>
    Effect.gen(function* () {
      // The counterpart of the retired "ad-hoc-tool hole" test in `src/permission-modes.test.ts`.
      // `MODE_RULES` still enumerates literal action names and still cannot mention a tool the model
      // invented at runtime — but it no longer has to, because the thing that used to answer for
      // that name (the catch-all) is gone and the fall-through is `ask` in every mode.
      const build = (yield* builtinAgents).get("build")!
      for (const mode of ["plan", "ask", "surgical", "bypass"] as const)
        expect({
          mode,
          effect: PermissionV2.evaluate("my_deploy_tool", "anything", [...build, ...MODE_RULES[mode]]).effect,
        }).toEqual({ mode, effect: "ask" })
      // `yolo` is the ONE deliberate way out and stays one — it is the documented "everything"
      // posture, and its overlay still names only the classes it names, so an ad-hoc tool asks
      // there too. Recorded rather than asserted as a guarantee: if yolo ever grows a catch-all,
      // that is a decision, and this line is where the next reader meets it.
      expect(PermissionV2.evaluate("my_deploy_tool", "anything", [...build, ...MODE_RULES.yolo]).effect).toBe("ask")
    }),
  )

  it.effect("the subagents' own denies still outrank the floor (order was not disturbed)", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      // `general` denies todowrite explicitly, AFTER the floor grants it.
      expect(effectFor(agents.get("general")!, "todowrite")).toBe("deny")
      // The three hidden single-purpose agents end in a catch-all DENY, so the floor reaches
      // nothing there — the same as before B4c, and the reason `catchAllAllowRules` must not
      // confuse a deny for an allow.
      for (const id of ["compaction", "title", "summary"])
        expect({ id, read: effectFor(agents.get(id)!, "read") }).toEqual({ id, read: "deny" })
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SCRATCH GRANTS, re-pointed here on 2026-09-04.
//
// 🔴 Four tests in `packages/novaclaw/test/agent/agent.test.ts` asserted exactly these facts —
// the truncation glob is writable, a temp child is writable, an arbitrary outside path is not —
// and none of them could fail. They evaluated `external_directory` against
// `novaclaw/src/agent/agent.ts`'s ruleset, which is not the gate: `packages/core` cannot import
// `packages/novaclaw`, so nothing this evaluator does ever saw those rules, and the action they
// named (`external_directory`, unsuffixed) matches neither real gate under `Wildcard.match`.
// They were deleted, and this block is what they were trying to say, asserted where it decides.
//
// ⚠️ The claim being pinned is a CAPABILITY, not a rule list: tool-output truncation writes into
// `Global.Path.data/tool-output` and scratch writes into the temp dir, so an agent that cannot
// write there is broken in a way no other suite reports — `truncate.ts` would simply start
// failing to save the output it promised the model it had saved.
// ─────────────────────────────────────────────────────────────────────────────
describe("the built-in floor's scratch dirs are writable, and nothing else is", () => {
  const outside = "/somewhere/else/x.ts"

  it.effect("both scratch dirs allow external read AND write", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      const build = agents.get(String(AgentV2.BUILD_ID))!
      // Non-vacuity: the loop below asserts nothing if the list is ever emptied, and emptying it is
      // exactly the regression this block exists to catch.
      expect(AgentPlugin.SCRATCH_DIRS.length, "the scratch list emptied — the loop below would pass vacuously").toBe(2)
      for (const dir of AgentPlugin.SCRATCH_DIRS) {
        // A resource under the glob, not the glob itself — the pattern is what a rule carries and
        // a real call arrives with a path. Asserting the glob against itself would pass on a rule
        // that matches nothing else.
        const resource = dir.replace(/\*$/, "probe.txt")
        expect(effectFor(build, "external_directory_read", resource), `read ${resource}`).toBe("allow")
        expect(effectFor(build, "external_directory_write", resource), `write ${resource}`).toBe("allow")
      }
    }),
  )

  it.effect("an arbitrary outside path is readable but NOT writable — 1I's classed access", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      const build = agents.get(String(AgentV2.BUILD_ID))!
      expect(effectFor(build, "external_directory_read", outside)).toBe("allow")
      // `ask`, and asking resolves to a refusal — what matters here is that it is not `allow`.
      expect(effectFor(build, "external_directory_write", outside)).not.toBe("allow")
    }),
  )

  /**
   * 🔴 **A skill or reference directory is NOT scratch, and that is a decision — see `SCRATCH_DIRS`.**
   *
   * A skill is durable INSTRUCTION injected into the prompt of sessions that do not exist yet, so an
   * agent able to author one grants itself influence over every session after it: *authority narrows
   * downward and never widens*. The legitimate need it would have served — notes, drafts, probes —
   * is already met by the colleague's own workspace, which `scratchDirsFor` grants without asking.
   *
   * Decided 2026-09-04, when a legacy rule that pretended to grant exactly this was deleted for
   * never having matched anything. Nothing about the behaviour changed then; this is the assertion
   * that says the intent was recorded rather than merely inherited from a rule that did nothing.
   */
  it.effect("a skill or reference directory is NOT writable — it is instruction, not scratch", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      const build = agents.get(String(AgentV2.BUILD_ID))!
      // The shapes `config/plugin/skill.ts` really registers: `<config dir>/skill` and `/skills`.
      const dirs = ["skill", "skills", "reference"].map((name) =>
        nodePath.join(Global.Path.config, name, "note.md").replaceAll("\\", "/"),
      )
      for (const resource of dirs) {
        // Reading stays allowed — 1I's ambient read baseline, asserted above for an arbitrary path.
        expect(effectFor(build, "external_directory_read", resource), `read ${resource}`).toBe("allow")
        // `ask`, which the assert path refuses. What matters is that it is never `allow`.
        expect(effectFor(build, "external_directory_write", resource), `write ${resource}`).not.toBe("allow")
      }
    }),
  )

  it.effect("NEGATIVE CONTROL: the unsuffixed action grants nothing, which is why the key was retired", () =>
    Effect.gen(function* () {
      const agents = yield* builtinAgents
      const build = agents.get(String(AgentV2.BUILD_ID))!
      const scratch = AgentPlugin.SCRATCH_DIRS[0]!.replace(/\*$/, "probe.txt")
      // If this ever starts returning `allow`, someone has re-added a bare `external_directory`
      // rule to the floor and collapsed the read/write class distinction 1I exists to keep.
      expect(effectFor(build, "external_directory", scratch)).not.toBe("allow")
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// THE `explore` SUBAGENT COULD NOT SEARCH — a shadowing bug that predates B4c and survived it.
//
// `explore` is the one built-in whose ruleset opens a catch-all DENY and then grants back what it
// needs. `evaluate` is findLast, so anything `defaults` contributes — including
// `AMBIENT_SAFE_BASELINE`'s `explore` allow — is shadowed by that deny, and `tool/glob.ts` /
// `tool/grep.ts` assert `explore`. So the read-only search agent was refused at its only job. The old
// catch-all ALLOW sat in the same shadowed position, so this was live before B4c as well.
//
// The fix is a grant, not a reordering — and since 2026-07-30 it is ONE grant. Both tools are now
// registered through `Tool.withPermission(…, "explore")`, so `ToolRegistry.materialize`'s horizon
// filter resolves the same action the execution assert spends. It used to take THREE rules —
// `explore` for execution plus `grep`/`glob` for the horizon, because that filter resolves the name a
// tool is REGISTERED under — and the two seams answering to different actions was itself the defect:
// `explore: "deny"` refused every search while both tools stayed advertised, and `glob: "deny"` hid
// glob while grep went on working. This block pins both halves of the single grant, execution AND
// horizon, so the collapse cannot silently come apart.
// ─────────────────────────────────────────────────────────────────────────────
describe("the explore subagent can actually glob and grep", () => {
  /**
   * `whollyDisabled` from `registry.ts`, replicated exactly (it is a module-private function there).
   * This is the predicate that decides whether a tool appears in the model's horizon at all, and it
   * is NOT the same question `evaluate` answers — it asks only whether the LAST rule matching the
   * action is a catch-all deny. Same replication-with-a-note shape `src/permission-modes.test.ts`
   * uses for the evaluator's private `denied()`.
   */
  const withdrawn = (rules: PermissionV2.Ruleset, action: string) => {
    const rule = rules.findLast((one) => Wildcard.match(action, one.action))
    return rule?.resource === "*" && rule.effect === "deny"
  }

  /**
   * The evaluator's HARD arm — `denied(input, configuredRules)` in `permission.ts` — which reads the
   * agent's own rules IN ISOLATION, before any mode overlay, so a configured deny cannot be softened.
   *
   * ⚠️ It is the right instrument here and `effectFor` above is not, which is worth stating because
   * the mistake is easy: `effectFor` composes `MODE_RULES[bypass]` last, and bypass ALLOWS
   * edit/write/create/trash/bash on `*` — so asking it whether this agent denies `bash` answers
   * "allow" while the shipped evaluator answers "deny". (Measured, not reasoned: that assertion was
   * written with `effectFor` first and went red.) The error direction is safe — it under-reports a
   * deny, so such a test fails rather than passing falsely — but a deny belongs where the evaluator
   * decides it.
   */
  const configuredDenies = (rules: PermissionV2.Ruleset, action: string, resource = "src/x.ts") =>
    PermissionV2.evaluate(action, resource, rules).effect === "deny"

  it.effect("EXECUTION: the `explore` action the two tools assert resolves to allow", () =>
    Effect.gen(function* () {
      const explore = (yield* builtinAgents).get("explore")!
      expect(effectFor(explore, "explore")).toBe("allow")
      // ...and its other grants are unharmed by the added rule.
      for (const action of ["read", "webfetch", "websearch"]) expect(effectFor(explore, action)).toBe("allow")
      // ...while the catch-all deny still does its job for everything else — asserted on the HARD
      // arm, which is where a configured deny is actually decided (see `configuredDenies`).
      for (const action of ["bash", "js", "edit", "write", "spawn", "todowrite"])
        expect({ action, denied: configuredDenies(explore, action) }).toEqual({ action, denied: true })
    }),
  )

  it.effect("NEGATIVE CONTROL: drop the `explore` grant and the subagent loses search at BOTH seams", () =>
    Effect.gen(function* () {
      const explore = (yield* builtinAgents).get("explore")!
      const preFix = explore.filter((rule) => rule.action !== "explore")
      // Execution is refused — which proves the assertion above measures the added rule and not the
      // ambient floor, present in both versions and shadowed in both.
      expect(effectFor(preFix, "explore")).toBe("deny")
      // And the horizon goes with it. THAT is what the remap bought: until 2026-07-30 the same
      // deletion left both tools ADVERTISED, because this agent carried separate `grep`/`glob`
      // grants that the horizon filter resolved instead — so the agent read as capable and failed
      // every call, which is a mystery rather than a missing capability.
      expect(withdrawn(preFix, "explore")).toBe(true)
    }),
  )

  it.effect("HORIZON: the ONE `explore` grant carries the tool list too, and no name-shaped rules remain", () =>
    Effect.gen(function* () {
      const explore = (yield* builtinAgents).get("explore")!
      // `whollyDisabled` resolves whatever `Tool.permission` answers, and both search tools remap to
      // `explore` — so this single rule is what keeps them on the model's horizon.
      expect(withdrawn(explore, "explore")).toBe(false)
      // The two rules that used to be needed for exactly this are GONE, and their absence is the
      // property being pinned: a ruleset that still named the registered tool names would mean the
      // collapse is half-done and the next reader has two mechanisms to reason about, not one.
      // (What a rule naming `glob`/`grep` does to the REAL registry — nothing, because the filter no
      // longer resolves those names — is asserted end-to-end in `tool-search-containment.test.ts`.)
      expect(explore.filter((rule) => rule.action === "glob" || rule.action === "grep")).toEqual([])
      // The replicated predicate is not vacuous: `read` is granted by name, so it is never withdrawn.
      expect(withdrawn(explore, "read")).toBe(false)
    }),
  )

  it.effect("the read-only explore agent can read host-readable files regardless of filename", () =>
    Effect.gen(function* () {
      const explore = (yield* builtinAgents).get("explore")!
      for (const resource of ["packages/core/.env", ".env.local", ".env.example", "src/x.ts"])
        expect(effectFor(explore, "read", resource)).toBe("allow")
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// …and the OTHER half of that grant, which lives in files this one cannot see.
//
// "The explore agent needs one `explore` grant" is only true while `tool/glob.ts` and `tool/grep.ts`
// BOTH assert `explore` and BOTH remap their horizon onto it. Those are claims about other files that
// compile green the moment they stop holding — ruling 1's defect class exactly — and either half
// coming off would silently re-break the subagent while every assertion above stayed green on a grant
// nobody spends: drop the assert and the execution gate spends a different action, drop the remap and
// the horizon filter falls back to the registered name and withdraws the tool.
// ─────────────────────────────────────────────────────────────────────────────
describe("glob and grep still assert `explore`, and still remap their horizon onto it", () => {
  // CODE ONLY: both files EXPLAIN the shared action at length, and a guard that read prose would be
  // satisfied by the comment describing the very rule it is meant to pin.
  const read = (file: string) =>
    stripComments(fs.readFileSync(nodePath.join(import.meta.dir, "..", "src", "tool", file), "utf8"))

  const ASSERTS_EXPLORE = /action:\s*"explore"/
  /** The remap is what points the horizon filter at `explore` instead of the registered name.
   *  `test/tool-permission-identity.test.ts` ledgers both sites and pins the action each remaps TO;
   *  this end pins only that it is still there, right next to the assert it has to agree with. */
  const REMAPS = /Tool\.withPermission\(/

  test.each([
    ["glob.ts", "glob"],
    ["grep.ts", "grep"],
  ])("%s asserts `explore`, registers as `%s`, and remaps onto `explore`", (file, name) => {
    const source = read(file)
    expect(source).toMatch(ASSERTS_EXPLORE)
    expect(source).toMatch(new RegExp(`export const name = "${name}"`))
    expect(source).toMatch(REMAPS)
    // Exactly ONE remap per file. A second would mean two horizon actions for one tool, which the
    // last `withPermission` call silently wins — a shape worth failing on rather than resolving.
    expect(source.match(/withPermission\(/g)).toHaveLength(1)
  })

  test("NEGATIVE CONTROL: both readers bite on a file that stopped doing it", () => {
    const renamed = `export const name = "glob"\nyield* permission.assert({ action: "glob", resources: [p] })\n`
    expect(renamed).not.toMatch(ASSERTS_EXPLORE)
    expect(renamed).not.toMatch(REMAPS)
    // ...and talking about either one is not doing it — the file as it shipped before 2026-07-30
    // carried a comment naming the remap it did not have.
    expect(stripComments(`// 1I: glob + grep share the action: "explore" grant class\n`)).not.toMatch(ASSERTS_EXPLORE)
    expect(stripComments(`// the only withPermission( remap in the tree is apply_patch\n`)).not.toMatch(REMAPS)
  })
})
