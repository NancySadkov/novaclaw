import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { ConfigReference } from "@novaclaw/core/config/reference"
import { ReferenceConfigSeed } from "@novaclaw/core/reference-config-seed"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 4 gates: layered round-trip + the idempotent jsonc seed with local-entry
// normalization (declaring-file-relative, `{ path }` object form).

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ReferenceConfigStore.node, FSUtil.node])))

describe("ReferenceConfigStore", () => {
  it.effect("round-trips ordered layers, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* ReferenceConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      const layers: ConfigReference.Entry[] = [
        "https://github.com/example/docs.git",
        ConfigReference.Local.make({ path: "/opt/docs", description: "local override" }),
      ]
      yield* store.setLayers("docs", layers)
      expect(yield* store.isEmpty()).toBe(false)
      expect((yield* store.references()).docs).toEqual(layers)

      yield* store.setLayers("docs", ["https://github.com/example/other.git"])
      expect((yield* store.references()).docs).toEqual(["https://github.com/example/other.git"])

      yield* store.removeReference("docs")
      expect(yield* store.isEmpty()).toBe(true)
    }),
  )

  it.effect("normalizeReferenceEntry resolves local entries to absolute { path } objects", () => {
    const home = "/home/test"
    expect(ReferenceConfigSeed.normalizeReferenceEntry("/proj", home, "./docs")).toEqual(
      ConfigReference.Local.make({ path: path.resolve("/proj", "./docs") }),
    )
    expect(ReferenceConfigSeed.normalizeReferenceEntry("/proj", home, "~/notes")).toEqual(
      ConfigReference.Local.make({ path: path.join(home, "notes") }),
    )
    expect(
      ReferenceConfigSeed.normalizeReferenceEntry(
        "/proj",
        home,
        ConfigReference.Local.make({ path: "../shared", hidden: true }),
      ),
    ).toEqual(ConfigReference.Local.make({ path: path.resolve("/proj", "../shared"), hidden: true }))
    // Git entries pass through untouched (string + object form).
    expect(ReferenceConfigSeed.normalizeReferenceEntry("/proj", home, "https://github.com/example/docs.git")).toBe(
      "https://github.com/example/docs.git",
    )
    return Effect.void
  })

  it.effect("jsonc seed imports layers once (global then project) and is idempotent", () =>
    Effect.gen(function* () {
      const store = yield* ReferenceConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      const projectDir = path.join(dir.path, "project")
      const home = path.join(dir.path, "home")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.mkdir(projectDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ references: { docs: "https://github.com/example/docs.git", "bad name": "./x" } }),
        )
        await fs.writeFile(
          path.join(projectDir, "novaclaw.jsonc"),
          JSON.stringify({ references: { docs: "./local-docs" } }),
        )
      })

      yield* ReferenceConfigSeed.seedFromDirectory(globalDir, projectDir, home)
      const first = yield* store.references()
      expect(first.docs).toEqual([
        "https://github.com/example/docs.git",
        ConfigReference.Local.make({ path: path.resolve(projectDir, "local-docs") }),
      ])
      expect(first["bad name"]).toBeUndefined() // invalid aliases never seed

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.setLayers("docs", ["https://github.com/example/edited.git"])
      yield* ReferenceConfigSeed.seedFromDirectory(globalDir, projectDir, home)
      expect((yield* store.references()).docs).toEqual(["https://github.com/example/edited.git"])
    }),
  )
})
