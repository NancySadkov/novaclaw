import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { AgentConfigSeed } from "@novaclaw/core/agent-config-seed"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Database } from "@novaclaw/core/database/database"
import { FSUtil } from "@novaclaw/core/fs-util"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SkillBuiltin } from "@novaclaw/core/skill/builtin"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

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

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AgentConfigStore.node, FSUtil.node])))

/** Seed the REAL clean-install roster, then read the researcher's folded config. */
const seededResearcher = Effect.gen(function* () {
  const store = yield* AgentConfigStore.Service
  const dir = yield* Effect.promise(() => tmpdir())
  yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
  const globalDir = path.join(dir.path, "global")
  yield* Effect.promise(() => fs.mkdir(globalDir, { recursive: true }))
  yield* AgentConfigSeed.seedFromDirectory(globalDir)
  const layers = (yield* store.agents())["researcher"]
  return layers === undefined ? undefined : AgentConfigStore.fold(layers)
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
  it.effect("🔴 is seeded as a PRIMARY officer on a clean install", () =>
    Effect.gen(function* () {
      const researcher = yield* seededResearcher
      expect(researcher).toBeDefined()
      expect(researcher!.mode).toBe("primary")
      expect(researcher!.title).toBe("Research Officer")
    }),
  )

  it.effect("🔴 may invoke the bundled skill as well as carrying its doctrine", () =>
    Effect.gen(function* () {
      const researcher = (yield* seededResearcher)!
      const rules = researcher.permissions as PermissionV2.Ruleset
      expect(PermissionV2.evaluate("skill", SkillBuiltin.RESEARCH_SKILL, rules).effect).toBe("allow")
    }),
  )

  it.effect("⚠️ the skill body itself is the officer's personality prompt", () =>
    Effect.gen(function* () {
      const researcher = (yield* seededResearcher)!
      const skill = SkillBuiltin.ALL.find((item) => item.name === SkillBuiltin.RESEARCH_SKILL)!
      expect(researcher.personality).toBe(skill.content)
    }),
  )
})
