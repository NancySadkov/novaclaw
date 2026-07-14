import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Config } from "@novaclaw/core/config"
import { SettingsConfigSeed } from "@novaclaw/core/settings-config-seed"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Location } from "@novaclaw/core/location"
import { Policy } from "@novaclaw/core/policy"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Config→SQLite step 6 gates: settings round-trip, the latest()-wins jsonc seed, and the
// synthetic-document overlay that makes every Config.latest() reader store-backed.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node, FSUtil.node])))

describe("SettingsConfigStore", () => {
  it.effect("round-trips values, replaces on set, removes, and reports emptiness", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      expect(yield* store.isEmpty()).toBe(true)

      yield* store.set("username", "store-user")
      yield* store.set("snapshots", false)
      yield* store.set("quality", { enabled: true, cadence: 3 })
      expect(yield* store.isEmpty()).toBe(false)
      expect(yield* store.all()).toEqual({
        username: "store-user",
        snapshots: false,
        quality: { enabled: true, cadence: 3 },
      })

      yield* store.set("username", "edited")
      expect((yield* store.all()).username).toBe("edited")

      yield* store.remove("username")
      yield* store.remove("snapshots")
      yield* store.remove("quality")
      expect(yield* store.isEmpty()).toBe(true)
    }),
  )

  it.effect("jsonc seed stores each key's latest() value (project wins) and is idempotent", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const globalDir = path.join(dir.path, "global")
      const projectDir = path.join(dir.path, "project")
      yield* Effect.promise(async () => {
        await fs.mkdir(globalDir, { recursive: true })
        await fs.mkdir(projectDir, { recursive: true })
        await fs.writeFile(
          path.join(globalDir, "novaclaw.jsonc"),
          JSON.stringify({ username: "global-user", snapshots: false, agents: { build: { description: "x" } } }),
        )
        await fs.writeFile(path.join(projectDir, "novaclaw.jsonc"), JSON.stringify({ username: "project-user" }))
      })

      yield* SettingsConfigSeed.seedFromDirectory(globalDir, projectDir)
      const all = yield* store.all()
      expect(all.username).toBe("project-user") // latest() semantics — the more specific doc wins
      expect(all.snapshots).toBe(false)
      expect(all.agents).toBeUndefined() // migrated subsystems never enter the settings store

      // A user edit after seeding must survive a re-seed (the isEmpty idempotence gate).
      yield* store.set("username", "user-edited")
      yield* SettingsConfigSeed.seedFromDirectory(globalDir, projectDir)
      expect((yield* store.all()).username).toBe("user-edited")
    }),
  )

  it.effect("settingsInfoFromStore builds the synthetic document latest() resolves FIRST", () =>
    Effect.sync(() => {
      const info = SettingsConfigSeed.settingsInfoFromStore({
        username: "store-user",
        snapshots: false,
        ignored_unknown_key: 1,
      })
      expect(info?.username).toBe("store-user")
      const entries = [
        new Config.Document({ type: "document", info: new Config.Info({ username: "doc-user", shell: "bash" }) }),
        new Config.Document({ type: "document", info: info! }),
      ]
      expect(Config.latest(entries, "username")).toBe("store-user") // store beats the doc
      expect(Config.latest(entries, "snapshots")).toBe(false)
      expect(Config.latest(entries, "shell")).toBe("bash") // a key absent from the store falls through
    }),
  )
})

describe("Config layer settings overlay", () => {
  const layerFor = (directory: string, globalDirectory: string) =>
    AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location(
              { directory: AbsolutePath.make(directory) },
              { projectDirectory: AbsolutePath.make(directory) },
            ),
          ),
        ),
      ],
      [Global.node, Global.layerWith({ config: globalDirectory })],
    ])

  it.effect("boot seeds the store from documents and serves them through the synthetic entry", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => tmp[Symbol.asyncDispose]()))
      const projectDir = path.join(tmp.path, "project")
      const globalDir = path.join(tmp.path, "global")
      yield* Effect.promise(async () => {
        await fs.mkdir(projectDir, { recursive: true })
        await fs.mkdir(globalDir, { recursive: true })
        await fs.writeFile(
          path.join(projectDir, "novaclaw.jsonc"),
          JSON.stringify({ username: "overlay-user", snapshots: false }),
        )
      })

      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const store = yield* SettingsConfigStore.Service
        const entries = yield* config.entries()
        // The layer seeded the store from the documents…
        expect((yield* store.all()).username).toBe("overlay-user")
        // …and appended the synthetic settings document (no path) carrying the values.
        const synthetic = entries.at(-1)
        expect(synthetic?.type).toBe("document")
        expect(synthetic?.type === "document" && synthetic.path).toBeUndefined()
        expect(Config.latest(entries, "username")).toBe("overlay-user")
        expect(Config.latest(entries, "snapshots")).toBe(false)
      }).pipe(Effect.provide(layerFor(projectDir, globalDir)))
    }),
  )
})
