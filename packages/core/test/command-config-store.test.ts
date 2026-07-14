import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { CommandConfigSeed } from "@novaclaw/core/command-config-seed"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigCommand } from "@novaclaw/core/config/command"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 3 gates: ordered layer round-trip + the idempotent jsonc seed.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, CommandConfigStore.node, FSUtil.node])))
const decodeCommand = Schema.decodeUnknownSync(ConfigCommand.Info)

describe("CommandConfigStore", () => {
  it.effect("round-trips ordered layers, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* CommandConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      const layers = [decodeCommand({ template: "first" }), decodeCommand({ template: "second", subtask: true })]
      yield* store.setLayers("review", layers)
      expect(yield* store.isEmpty()).toBe(false)
      expect((yield* store.commands()).review).toEqual(layers)

      yield* store.setLayers("review", [decodeCommand({ template: "third" })])
      expect((yield* store.commands()).review).toEqual([decodeCommand({ template: "third" })])

      yield* store.removeCommand("review")
      expect(yield* store.isEmpty()).toBe(true)
    }),
  )

  it.effect("jsonc seed imports command layers once and is idempotent (store edits win)", () =>
    Effect.gen(function* () {
      const store = yield* CommandConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      const projectDir = path.join(dir.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.mkdir(projectDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ commands: { review: { template: "global review" } } }),
        )
        await fs.writeFile(
          path.join(projectDir, "novaclaw.jsonc"),
          JSON.stringify({ commands: { review: { template: "project review" }, docs: { template: "write docs" } } }),
        )
      })

      yield* CommandConfigSeed.seedFromDirectory(globalDir, projectDir)
      const first = yield* store.commands()
      expect(first.review).toEqual([decodeCommand({ template: "global review" }), decodeCommand({ template: "project review" })])
      expect(first.docs).toEqual([decodeCommand({ template: "write docs" })])

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.setLayers("review", [decodeCommand({ template: "user edited" })])
      yield* CommandConfigSeed.seedFromDirectory(globalDir, projectDir)
      expect((yield* store.commands()).review).toEqual([decodeCommand({ template: "user edited" })])
    }),
  )
})
