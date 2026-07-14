import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import { PluginConfigSeed } from "@novaclaw/core/plugin-config-seed"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 5 gates: spec round-trip + the idempotent jsonc seed with
// declaring-file-relative package normalization.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, PluginConfigStore.node, FSUtil.node])))

describe("PluginConfigStore", () => {
  it.effect("round-trips specs in insertion order, last-write-wins on options, removes, reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* PluginConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      yield* store.setPlugin({ package: "example-plugin@1.0.0", options: { mode: "a" } })
      yield* store.setPlugin({ package: "/opt/plugins/local.js" })
      yield* store.setPlugin({ package: "example-plugin@1.0.0", options: { mode: "b" } })
      expect(yield* store.isEmpty()).toBe(false)
      expect(yield* store.plugins()).toEqual([
        { package: "example-plugin@1.0.0", options: { mode: "b" } },
        { package: "/opt/plugins/local.js" },
      ])

      yield* store.removePlugin("/opt/plugins/local.js")
      expect(yield* store.plugins()).toEqual([{ package: "example-plugin@1.0.0", options: { mode: "b" } }])
    }),
  )

  it.effect("normalizePluginEntry resolves relative + file:// specs against the declaring file", () => {
    expect(PluginConfigSeed.normalizePluginEntry("/proj", "./plugins/a.js")).toEqual({
      package: path.resolve("/proj", "./plugins/a.js"),
    })
    expect(
      PluginConfigSeed.normalizePluginEntry("/proj", { package: "../shared/b.js", options: { x: 1 } }),
    ).toEqual({ package: path.resolve("/proj", "../shared/b.js"), options: { x: 1 } })
    const fileUrl = pathToFileURL(path.resolve("/proj/plugins/c.js")).href
    expect(PluginConfigSeed.normalizePluginEntry("/proj", fileUrl)).toEqual({
      package: path.resolve("/proj/plugins/c.js"),
    })
    // Bare npm names pass through untouched.
    expect(PluginConfigSeed.normalizePluginEntry("/proj", "example-plugin@1.0.0")).toEqual({
      package: "example-plugin@1.0.0",
    })
    return Effect.void
  })

  it.effect("jsonc seed imports specs once (global then project) and is idempotent", () =>
    Effect.gen(function* () {
      const store = yield* PluginConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      const projectDir = path.join(dir.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.mkdir(projectDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ plugins: ["team-plugin@2.0.0"] }),
        )
        await fs.writeFile(
          path.join(projectDir, "novaclaw.jsonc"),
          JSON.stringify({ plugins: [{ package: "./tools/local.js", options: { enabled: true } }] }),
        )
      })

      yield* PluginConfigSeed.seedFromDirectory(globalDir, projectDir)
      expect(yield* store.plugins()).toEqual([
        { package: "team-plugin@2.0.0" },
        // relative → the DECLARING file's dir, stored absolute
        { package: path.resolve(projectDir, "tools/local.js"), options: { enabled: true } },
      ])

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.removePlugin("team-plugin@2.0.0")
      yield* PluginConfigSeed.seedFromDirectory(globalDir, projectDir)
      expect(((yield* store.plugins()).map((entry) => entry.package)).includes("team-plugin@2.0.0")).toBe(false)
    }),
  )
})
