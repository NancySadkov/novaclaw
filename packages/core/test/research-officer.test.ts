import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { FSUtil } from "@novaclaw/core/fs-util"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SkillBuiltin } from "@novaclaw/core/skill/builtin"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

/**
 * THE RESEARCH OFFICER, AND THE SKILL IT STANDS ON.
 *
 * 🔴 Shipping an officer whose prompt names a skill has three ways to become a lie, and each is
 * silent: the skill is not bundled, the officer is not registered, or the officer is registered but
 * cannot REACH the skill because nothing granted it. Each produces a confident agent with opinions
 * about rigour instead of the commandments it was supposed to read.
 *
 * ⚠️ The drift this file really exists to catch is a RENAME. The officer's grant is written as
 * `SkillBuiltin.RESEARCH_SKILL`, and the skill's own frontmatter declares `name: research`; if those
 * two ever disagree the permission points at a skill that does not exist and the failure surfaces as
 * "the model didn't use the skill", which reads like a model problem.
 */

const at = Location.Service.of(location({ directory: AbsolutePath.make("/project") }))
const it = testEffect(AppNodeBuilder.build(LayerNode.group([AgentV2.node, FSUtil.node])))

/** Build the built-in roster with the REAL plugin — no hand-written fixture of what it registers. */
const builtins = Effect.gen(function* () {
  const agent = yield* AgentV2.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(Effect.provideService(Location.Service, at))
  return new Map((yield* agent.all()).map((item) => [String(item.id), item]))
})

describe("the bundled research skill", () => {
  it.effect("🔴 ships in the binary — it is not a file the user has to have", () =>
    Effect.sync(() => {
      const research = SkillBuiltin.ALL.find((skill) => skill.name === SkillBuiltin.RESEARCH_SKILL)
      expect(research).toBeDefined()
      expect(research!.description.length).toBeGreaterThan(40)
      expect(research!.content.length).toBeGreaterThan(2000)
    }),
  )

  it.effect("⚠️ the frontmatter is STRIPPED — `name:` and `description:` are not guidance", () =>
    Effect.sync(() => {
      const research = SkillBuiltin.ALL.find((skill) => skill.name === SkillBuiltin.RESEARCH_SKILL)!
      expect(research.content.startsWith("---")).toBe(false)
      // The first line of the body, not of the file.
      expect(research.content.split("\n")[0]).toContain("Research")
    }),
  )

  it.effect("carries the commandments it is named for, so a truncated bundle is caught", () =>
    Effect.sync(() => {
      const research = SkillBuiltin.ALL.find((skill) => skill.name === SkillBuiltin.RESEARCH_SKILL)!
      // Three rules from three different sections: a bundle that lost its tail still fails here.
      expect(research.content).toContain("Check the instrument before you trust the number")
      expect(research.content).toContain("Control the ENVIRONMENT, not just the variable")
      expect(research.content).toContain("Your own rig is the most likely confound")
    }),
  )
})

describe("the research officer", () => {
  it.effect("🔴 is REGISTERED by the plugin, like the other shipped agents", () =>
    Effect.gen(function* () {
      const roster = yield* builtins
      const researcher = roster.get("researcher")
      expect(researcher).toBeDefined()
      expect(researcher!.mode).toBe("subagent")
      expect(String(researcher!.description)).toContain("EVIDENCE")
    }),
  )

  it.effect("🔴 may actually INVOKE the skill — the prompt asks, the charter permits", () =>
    Effect.gen(function* () {
      const roster = yield* builtins
      const rules = roster.get("researcher")!.permissions as PermissionV2.Ruleset
      expect(PermissionV2.evaluate("skill", SkillBuiltin.RESEARCH_SKILL, rules).effect).toBe("allow")
    }),
  )

  it.effect("⚠️ its prompt NAMES the skill that is actually bundled", () =>
    Effect.gen(function* () {
      // The rename guard. A prompt naming `research` while the bundle ships `research-v2` is a
      // failure no type checks and no test of either half alone can see.
      const roster = yield* builtins
      const system = String(roster.get("researcher")!.system ?? "")
      expect(system).toContain(SkillBuiltin.RESEARCH_SKILL)
      expect(system.length).toBeGreaterThan(200)
    }),
  )

  it.effect("⚠️ shipping it did not disturb the other built-ins", () =>
    Effect.gen(function* () {
      const roster = yield* builtins
      for (const id of ["build", "plan", "nova", "general", "explore"]) expect(roster.has(id)).toBe(true)
    }),
  )
})
