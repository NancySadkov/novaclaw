import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { AgentConfigSeed } from "@novaclaw/core/agent-config-seed"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 2 gates: the store round-trips ordered agent layers, and the transitional
// jsonc seed is IDEMPOTENT — later store edits win over a re-run (jsonc is import-only).

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, AgentConfigStore.node, FSUtil.node])))
const decodeAgent = Schema.decodeUnknownSync(ConfigAgent.Info)

describe("AgentConfigStore", () => {
  it.effect("round-trips ordered layers, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      const layers = [decodeAgent({ description: "first" }), decodeAgent({ hidden: true })]
      yield* store.setLayers("reviewer", layers)
      expect(yield* store.isEmpty()).toBe(false)
      expect((yield* store.agents()).reviewer).toEqual(layers)

      // A second set REPLACES the full ordered list (no append).
      yield* store.setLayers("reviewer", [decodeAgent({ description: "second" })])
      expect((yield* store.agents()).reviewer).toEqual([decodeAgent({ description: "second" })])

      yield* store.removeAgent("reviewer")
      expect(yield* store.isEmpty()).toBe(true)
    }),
  )

  it.effect("default agent: set wins, setDefaultIfEmpty never clobbers", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      expect(yield* store.getDefault()).toBeUndefined()
      yield* store.setDefaultIfEmpty("build")
      expect(yield* store.getDefault()).toBe("build")
      yield* store.setDefaultIfEmpty("plan")
      expect(yield* store.getDefault()).toBe("build") // protected
      yield* store.setDefault("plan")
      expect(yield* store.getDefault()).toBe("plan") // explicit set wins
    }),
  )

  it.effect("jsonc seed imports agents + default once and is idempotent (store edits win)", () =>
    Effect.gen(function* () {
      const store = yield* AgentConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      const projectDir = path.join(dir.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.mkdir(projectDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ agents: { reviewer: { description: "global reviewer" } } }),
        )
        await fs.writeFile(
          path.join(projectDir, "novaclaw.jsonc"),
          JSON.stringify({
            default_agent: "reviewer",
            agents: { reviewer: { hidden: true }, scribe: { description: "project scribe" } },
          }),
        )
      })

      yield* AgentConfigSeed.seedFromDirectory(globalDir, projectDir)
      const first = yield* store.agents()
      // Global layer first, project layer second (specific wins on merge).
      expect(first.reviewer).toEqual([decodeAgent({ description: "global reviewer" }), decodeAgent({ hidden: true })])
      expect(first.scribe).toEqual([decodeAgent({ description: "project scribe" })])
      expect(yield* store.getDefault()).toBe("reviewer")

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.setLayers("reviewer", [decodeAgent({ description: "user edited" })])
      yield* store.setDefault("scribe")
      yield* AgentConfigSeed.seedFromDirectory(globalDir, projectDir)
      expect((yield* store.agents()).reviewer).toEqual([decodeAgent({ description: "user edited" })])
      expect(yield* store.getDefault()).toBe("scribe")
    }),
  )
})
