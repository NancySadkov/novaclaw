import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Scratch } from "@novaclaw/core/scratch"
import { AgentV2 } from "@novaclaw/core/agent"
import type { ConfigAgent } from "@novaclaw/core/config/agent"
import { ConfigAgent as ConfigAgentSchema } from "@novaclaw/core/config/agent"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigAgentPlugin } from "@novaclaw/core/config/plugin/agent"
import { FSUtil } from "@novaclaw/core/fs-util"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { AbsolutePath } from "@novaclaw/core/schema"
import { EFFECTIVE_CONFIG_DEFAULTS, MODE_RULES } from "@novaclaw/core/session/config-resolve"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

// What a HIRED colleague may actually do (AGENTS.md — the structural metaphor).
//
// 🔴 The roster's whole premise is officers the USER creates. They are config rows, not built-ins,
// and `plugin/agent.ts` pushes `AMBIENT_SAFE_BASELINE` into the agents IT builds — so a hired
// colleague starts from `permissions: []` (`schema/agent.ts`) plus whatever the config files carry.
// Everything unmatched falls to the evaluator's `ask`, which the assert path turns into a REFUSAL
// (`bf39088eb`, *Ask considered harmful*).
//
// ⚠️ This file MEASURES that rather than asserting it from the source, because reading a permission
// chain and running one have disagreed here before. It builds the real built-ins with the real
// plugin and applies a real config fragment through the real `applyItem`.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AgentV2.node, FSUtil.node])))

/** The instance-wide agent store, in memory — the same shape `test/config/agent.test.ts` uses. */
const memoryStore = () => {
  const layers = new Map<string, ConfigAgent.Info[]>()
  let defaultAgent: string | undefined
  return AgentConfigStore.Service.of({
    agents: () => Effect.sync(() => Object.fromEntries(layers)),
    setLayers: (name, next) => Effect.sync(() => void layers.set(name, [...next])),
    removeAgent: (name) => Effect.sync(() => void layers.delete(name)),
    getDefault: () => Effect.sync(() => defaultAgent),
    setDefault: (name) => Effect.sync(() => void (defaultAgent = name)),
    clearDefault: () => Effect.sync(() => void (defaultAgent = undefined)),
    setDefaultIfEmpty: (name) => Effect.sync(() => void (defaultAgent ??= name)),
    isEmpty: () => Effect.sync(() => layers.size === 0),
  })
}

const at = Location.Service.of(location({ directory: AbsolutePath.make("/project") }))

/** Build the built-ins with the real plugin, then hire `theron` the way the roster's Hire button
 *  does — a store layer, applied by the real config plugin. No hand-written fixture of either. */
const rosterWith = (fragment: Record<string, unknown>) =>
  Effect.gen(function* () {
    const agent = yield* AgentV2.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
      Effect.provideService(Location.Service, at),
    )
    const store = memoryStore()
    yield* store.setLayers("theron", [Schema.decodeUnknownSync(ConfigAgentSchema.Info)(fragment)])
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
      Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
      Effect.provideService(AgentConfigStore.Service, store),
    )
    return new Map((yield* agent.all()).map((item) => [String(item.id), item.permissions as PermissionV2.Ruleset]))
  })

const effectFor = (rules: PermissionV2.Ruleset, action: string, resource = "src/x.ts") =>
  PermissionV2.evaluate(action, resource, [...rules, ...MODE_RULES[EFFECTIVE_CONFIG_DEFAULTS.permissionMode]]).effect

describe("a colleague the user hired", () => {
  it.effect("stands on the SAME floor as a built-in, action for action", () =>
    Effect.gen(function* () {
      const roster = yield* rosterWith({ name: "Theron", mode: "primary" })
      const hired = roster.get("theron")!
      const builtin = roster.get("build")!
      // Compared against `build` rather than against a list of actions this file believes are
      // ambient-safe: the membership of that baseline is not this file's claim, and a hand-copied
      // list would go stale the day it changes.
      //
      // Three deliberate differences are excluded: `colleague` (an officer may address peers, `build`
      // may not — its own test below), `plan_enter` (a colleague that switched the user's mode under
      // them would be a surprise; the person has a mode picker, and `build` is the agent that picker
      // drives), and `question` — denied for officers under principle 14, *the chat IS the channel*,
      // while `build` keeps a grant for an action whose tool no longer exists.
      for (const action of [
        "read",
        "explore",
        "todowrite",
        "resource_status",
        "webfetch",
        "js",
        "kb",
        "external_directory_write",
      ])
        expect({ action, hired: effectFor(hired, action) }).toEqual({ action, hired: effectFor(builtin, action) })
    }),
  )

  it.effect("can address its PEERS — that is what makes them colleagues", () =>
    Effect.gen(function* () {
      const roster = yield* rosterWith({ name: "Theron", mode: "primary" })
      // "Top level executive agents who can communicate with each other" (owner). Staffing stays
      // Nova's alone, and `tool/colleague.ts` → `mayStaff` enforces that independently of this dial.
      expect(effectFor(roster.get("theron")!, "colleague")).toBe("allow")
    }),
  )

  it.effect("keeps its OWN workspace, even when assigned to a project", () =>
    Effect.gen(function* () {
      const roster = yield* rosterWith({ name: "Theron", mode: "primary", directory: "D:/books" })
      const hired = roster.get("theron")!
      // 🔴 Owner: "the agent with an assigned folder has both scratch and the project folders."
      // Assigning a colleague to a project used to take away the one place it could keep notes and
      // drafts without asking — and AGENTS.md says scratch is how a model is meant to work at all.
      const mine = `${Scratch.forAgent("theron").replaceAll(String.fromCharCode(92), "/")}/notes.md`
      expect(effectFor(hired, "external_directory_write", mine)).toBe("allow")
      expect(effectFor(hired, "external_directory_read", mine)).toBe("allow")
    }),
  )

  it.effect("…and NOT into another colleague's workspace", () =>
    Effect.gen(function* () {
      // The whole point of a private workspace. `external_directory_write` on `*` is `ask` on the
      // floor, which the assert path refuses — so a stray write into a peer's drafts is not a rule
      // that has to be remembered, it simply is not granted.
      const roster = yield* rosterWith({ name: "Theron", mode: "primary", directory: "D:/books" })
      const theirs = `${Scratch.forAgent("aris").replaceAll(String.fromCharCode(92), "/")}/notes.md`
      expect(effectFor(roster.get("theron")!, "external_directory_write", theirs)).not.toBe("allow")
    }),
  )

  it.effect("can staff ITSELF — and cannot borrow another agent's standing to do it", () =>
    Effect.gen(function* () {
      const roster = yield* rosterWith({ name: "Theron", mode: "primary" })
      const hired = roster.get("theron")!
      // The metaphor's other half: *"…and spawn the nameless sub-agents"*. A hired officer gets this
      // from the officer floor, the same door `colleague` comes through.
      expect(effectFor(hired, "spawn", "inherit")).toBe("allow")
      // 🔴 AND NO FURTHER. `inherit` runs the child as Theron under Theron's own ruleset, so it can
      // do nothing Theron could not. Naming another agent is the form that WOULD widen — a narrow
      // colleague reaching for a broader one's standing — and it stays ungranted. This assertion is
      // the whole reason the grant is safe; if it ever reads "allow", the grant is an escalation.
      expect(effectFor(hired, "spawn", "build")).toBe("ask")
      expect(effectFor(hired, "spawn", "nova")).toBe("ask")
    }),
  )

  it.effect("a config-defined SUB-agent staffs nobody — staff cannot staff", () =>
    Effect.gen(function* () {
      // ⚠️ `rosterWith` always stores the agent under the id `theron`; the MODE is the variable.
      const roster = yield* rosterWith({ name: "Runner", mode: "subagent" })
      // "Staff and temps — sub-agents inherit their officer's scope, narrowed, never widened"
      // (AGENTS.md). A sub-agent that could spawn would be a branch of the org chart that grows
      // sideways with nobody named on it.
      //
      // ⚠️ `ask`, and `ask` is a REFUSAL here: the floor gives non-officers no spawn rule at all, so
      // the action falls through to the evaluator's default — and asking was removed (owner
      // 2026-08-20), so `PermissionV2.assert` turns every unresolved ask into a denial. Asserting
      // the ruleset's verdict rather than the assert path's is deliberate: this file measures what
      // the FLOOR says, and `permission.test.ts` owns the conversion.
      expect(effectFor(roster.get("theron")!, "spawn", "inherit")).toBe("ask")
    }),
  )

  it.effect("is still bound by the floor's refusals", () =>
    Effect.gen(function* () {
      const roster = yield* rosterWith({ name: "Theron", mode: "primary" })
      // Inheriting a baseline must not become inheriting a catch-all: hiring a colleague cannot be a
      // privilege-escalation move, so the floor's own denies have to survive the copy.
      expect(effectFor(roster.get("theron")!, "plan_enter")).toBe("deny")
      // Principle 14: a colleague that needs a decision says so in its REPLY. It never opens a side
      // channel and waits — so the action stays refused even for the agents a person chats with.
      //
      // ⚠️ **`ask`, not `deny`, and the mechanism changing is the point.** This asserted a literal
      // `deny` rule until 2026-09-01, when the floor's `question` rule was removed along with the
      // FOUR re-allows that had been sitting under it — six rules over an action with no tool behind
      // it (`bf39088eb` retired the ask outcome and took the tool off the horizon), where the comment
      // claimed a prohibition the file below reversed four times. With no rule, the action falls
      // through to the evaluator's default exactly as `spawn` does above, and that default is a
      // refusal: `permission.ts` rewrites an unresolved `ask` into deny rules with reason
      // `ask-removed`.
      //
      // 🔴 So this now asserts the PROPERTY rather than the rule that used to carry it — the
      // assertion below is what would fail if anyone ever made `question` reachable. Principle 14
      // calls itself structural rather than a policy toggle, and a floor entry for a tool that does
      // not exist is the toggle, not the structure.
      expect(effectFor(roster.get("theron")!, "question")).toBe("ask")
      expect(effectFor(roster.get("theron")!, "question")).not.toBe("allow")
      expect(PermissionV2.catchAllAllowRules(roster.get("theron")!)).toEqual([])
    }),
  )

  it.effect("nameless STAFF get the floor without the hand-off tool", () =>
    Effect.gen(function* () {
      // A config-defined sub-agent is staff, not a colleague: it should be able to read, and it has
      // nobody to hand work to.
      const roster = yield* rosterWith({ name: "Helper", mode: "subagent" })
      const staff = roster.get("theron")!
      expect(effectFor(staff, "read")).toBe("allow")
      expect(effectFor(staff, "colleague")).toBe("deny")
    }),
  )

  it.effect("an explicit rule in the fragment still beats the floor", () =>
    Effect.gen(function* () {
      // The floor is a FLOOR, not a ceiling the user cannot edit: a colleague configured to refuse
      // something must refuse it, even though the floor allows it.
      const roster = yield* rosterWith({
        name: "Theron",
        mode: "primary",
        permissions: [{ action: "read", resource: "*", effect: "deny" }],
      })
      expect(effectFor(roster.get("theron")!, "read")).toBe("deny")
    }),
  )

  it.effect("MEASURED, not assumed: the session MODE still outranks an agent's own rule", () =>
    Effect.gen(function* () {
      // Pre-existing and worth stating rather than discovering twice: `evaluateInput` appends the
      // mode overlay AFTER the agent's ruleset and `evaluate` takes the LAST match, so a colleague
      // configured `bash: deny` still runs shell commands under the shipped `bypass` mode. Not
      // changed here — pinned so the next person reads it as a decision rather than a surprise.
      const roster = yield* rosterWith({
        name: "Theron",
        mode: "primary",
        permissions: [{ action: "bash", resource: "*", effect: "deny" }],
      })
      const rules = roster.get("theron")!
      expect(PermissionV2.evaluate("bash", "ls", rules).effect).toBe("deny")
      expect(effectFor(rules, "bash")).toBe("allow")
    }),
  )
})
