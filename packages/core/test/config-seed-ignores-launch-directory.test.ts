import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { CatalogSeed } from "@novaclaw/core/catalog-seed"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { SettingsConfigSeed } from "@novaclaw/core/settings-config-seed"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

/**
 * NEGATIVE CONTROL for a removed opencode-legacy behaviour (2026-07-27).
 *
 * First-boot seeding used to read the LAUNCH DIRECTORY (`process.cwd()`) as well as the config dir.
 * Because seeding is `isEmpty`-gated and one-time, that meant **whichever process booted first
 * silently defined instance-wide settings forever** — running `novaclaw` once inside a checkout could
 * permanently pin the instance's providers to whatever that repo happened to contain, with no message
 * and no way to tell afterwards. It is also what made a config file at a project root "work", which is
 * why one sat in the plan repo for months.
 *
 * Config is INSTANCE-level, so it comes from the instance's config dir. If a per-project config ever
 * returns it must be a real location-scoped store consulted at resolution time — never a first-boot
 * import from cwd.
 *
 * These tests fail if anyone re-adds the leg: each plants a config in a directory that is NOT the
 * config dir, makes it the process cwd, and asserts none of it reaches a store.
 */
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SettingsConfigStore.node, CatalogStore.node, FSUtil.node])),
)

describe("config seeding ignores the launch directory", () => {
  it.effect("a novaclaw.jsonc in the cwd contributes NOTHING to the settings store", () =>
    Effect.gen(function* () {
      const store = yield* SettingsConfigStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = path.join(dir.path, "config")
      const cwdDir = path.join(dir.path, "some-checkout")
      yield* Effect.promise(async () => {
        await fs.mkdir(configDir, { recursive: true })
        await fs.mkdir(cwdDir, { recursive: true })
        await fs.writeFile(path.join(configDir, "novaclaw.jsonc"), JSON.stringify({ username: "from-config-dir" }))
        await fs.writeFile(
          path.join(cwdDir, "novaclaw.jsonc"),
          JSON.stringify({ username: "from-cwd", shell: "/bin/definitely-not-this" }),
        )
      })

      const previous = process.cwd()
      try {
        process.chdir(cwdDir)
        yield* SettingsConfigSeed.seedFromDirectory(configDir)
      } finally {
        process.chdir(previous)
      }

      const all = yield* store.all()
      expect(all.username).toBe("from-config-dir")
      expect(all.shell).toBeUndefined() // the cwd document was never read
    }),
  )

  it.effect("a provider declared only in the cwd never enters the catalog", () =>
    Effect.gen(function* () {
      const store = yield* CatalogStore.Service
      const dir = yield* Effect.promise(() => tmpdir())
      yield* Effect.addFinalizer(() => Effect.promise(() => dir[Symbol.asyncDispose]()))
      const configDir = path.join(dir.path, "config")
      const cwdDir = path.join(dir.path, "some-checkout")
      yield* Effect.promise(async () => {
        await fs.mkdir(configDir, { recursive: true })
        await fs.mkdir(cwdDir, { recursive: true })
        const provider = (url: string) => ({
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url, settings: {} },
        })
        await fs.writeFile(
          path.join(configDir, "novaclaw.jsonc"),
          JSON.stringify({ providers: { "from-config-dir": provider("http://127.0.0.1:1/v1") } }),
        )
        await fs.writeFile(
          path.join(cwdDir, "novaclaw.jsonc"),
          JSON.stringify({ providers: { "from-cwd": provider("http://127.0.0.1:2/v1") } }),
        )
      })

      const previous = process.cwd()
      try {
        process.chdir(cwdDir)
        yield* CatalogSeed.seedFromDirectory(configDir)
      } finally {
        process.chdir(previous)
      }

      const providers = yield* store.providers()
      expect(Object.keys(providers)).toContain("from-config-dir")
      expect(Object.keys(providers)).not.toContain("from-cwd")
    }),
  )
})
