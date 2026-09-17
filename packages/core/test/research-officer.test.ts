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
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

/**
 * THE RESEARCHER, AND THE DOCTRINE IT CARRIES AS ITS OWN PROMPT.
 *
 * 🔴 The doctrine used to ship as a bundled skill the officer was granted access to. Skills are
 * retired (owner, 2026-09-17): a named officer's own prompt is the single source of what it does, so
 * the commandments are now the officer's job brief — a document beside `agent/`, not a second,
 * model-addressable copy that can drift from it. These pin the three silent ways that can become a
 * lie: the document is not bundled, the officer is not seeded, or its prompt lost the doctrine.
 */

const doctrine = () =>
  fs.readFile(path.join(import.meta.dir, "..", "src", "agent", "research-officer.txt"), "utf8")

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

describe("the research doctrine", () => {
  it.effect("🔴 ships in the binary — it is not a file the user has to have", () =>
    Effect.gen(function* () {
      const content = yield* Effect.promise(doctrine)
      expect(content.length).toBeGreaterThan(2000)
    }),
  )

  it.effect("carries the commandments it is named for, so a truncated document is caught", () =>
    Effect.gen(function* () {
      const content = yield* Effect.promise(doctrine)
      // Three rules from three different sections: a document that lost its tail still fails here.
      expect(content).toContain("Check the instrument before you trust the number")
      expect(content).toContain("Control the ENVIRONMENT, not just the variable")
      expect(content).toContain("Your own rig is the most likely confound")
    }),
  )
})

describe("the researcher", () => {
  it.effect("🔴 is seeded as a PRIMARY officer on a clean install", () =>
    Effect.gen(function* () {
      const researcher = yield* seededResearcher
      expect(researcher).toBeDefined()
      expect(researcher!.mode).toBe("primary")
      expect(researcher!.title).toBe("Researcher")
    }),
  )

  it.effect("⚠️ the doctrine IS its prompt — the officer reads the commandments as its brief", () =>
    Effect.gen(function* () {
      const researcher = (yield* seededResearcher)!
      expect(researcher.system).toContain("Check the instrument before you trust the number")
    }),
  )

  it.effect("holds no skill grant — the mechanism is gone, not merely unused", () =>
    Effect.gen(function* () {
      const researcher = (yield* seededResearcher)!
      // No permission rules at all: the grant went with the skill it named.
      expect(researcher.permissions ?? []).toHaveLength(0)
    }),
  )
})
