import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { testEffect } from "./lib/effect"

// Config→SQLite step 7 gates: the updateConfig patch router (per-store semantics) + the
// read overlay that mirrors routed keys back onto the file-derived view.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      AgentConfigStore.node,
      CatalogStore.node,
      CommandConfigStore.node,
      PluginConfigStore.node,
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
      SkillConfigStore.node,
    ]),
  ),
)

const decodeInfo = Schema.decodeUnknownSync(Config.Info)

describe("ConfigStoreWrite.mergePatch", () => {
  it.effect("merges objects deep, replaces arrays and primitives", () => {
    expect(ConfigStoreWrite.mergePatch({ a: { b: 1, c: 2 }, keep: true }, { a: { b: 9 } })).toEqual({
      a: { b: 9, c: 2 },
      keep: true,
    })
    expect(ConfigStoreWrite.mergePatch({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] })
    expect(ConfigStoreWrite.mergePatch(undefined, { x: 1 })).toEqual({ x: 1 })
    expect(ConfigStoreWrite.mergePatch({ x: 1 }, null)).toBeNull()
    return Effect.void
  })
})

describe("ConfigStoreWrite.apply", () => {
  it.effect("routes settings keys with merge-in-place and reports consumed keys", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("quality", { enabled: true, checks: { build: "make" } })

      const consumed = yield* ConfigStoreWrite.apply(decodeInfo({ quality: { enabled: false }, shell: "bash" }))
      expect([...consumed].sort()).toEqual(["quality", "shell"])

      const all = yield* settings.all()
      // Deep merge: the patch flips `enabled`, the stored `checks` survives.
      expect(all.quality).toEqual({ enabled: false, checks: { build: "make" } })
      expect(all.shell).toBe("bash")
    }),
  )

  it.effect("appends provider patches as layers and sets the default model", () =>
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      const base = decodeInfo({
        providers: { spark: { name: "Spark", models: { m1: { name: "M1" } } } },
      }).providers!.spark
      yield* catalog.setLayers(ProviderV2.ID.make("spark"), [base])

      const patch = decodeInfo({
        model: "spark/m1",
        providers: { spark: { models: { m1: { name: "M1 renamed" } } } },
      })
      const consumed = yield* ConfigStoreWrite.apply(patch)
      expect([...consumed].sort()).toEqual(["model", "providers"])

      const layers = (yield* catalog.providers())["spark"]!
      expect(layers).toHaveLength(2)
      expect(layers[1]?.models?.["m1"]?.name).toBe("M1 renamed")
      expect(yield* catalog.getDefault()).toBe("spark/m1")
    }),
  )

  it.effect("replaces list stores wholesale (skills, plugins) and leaves unrouted keys unconsumed", () =>
    Effect.gen(function* () {
      const skills = yield* SkillConfigStore.Service
      yield* skills.addSource("/old/skills")
      const plugins = yield* PluginConfigStore.Service
      yield* plugins.setPlugin({ package: "old-plugin" })

      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({
          skills: ["/new/skills"],
          plugins: ["new-plugin"],
          instructions: ["keep-on-jsonc.md"],
          disabled_providers: ["x"],
        }),
      )
      expect([...consumed].sort()).toEqual(["plugins", "skills"])
      expect(yield* skills.sources()).toEqual(["/new/skills"])
      expect(yield* plugins.plugins()).toEqual([{ package: "new-plugin" }])
    }),
  )
})

describe("ConfigStoreWrite.overlay", () => {
  it.effect("mirrors settings, folded providers, and defaults over the file view", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("strict", { enabled: true, attempts: 3 })
      const catalog = yield* CatalogStore.Service
      const info = decodeInfo({
        providers: { spark: { name: "Spark", models: { m1: { name: "M1" } } } },
      }).providers!.spark
      const rename = decodeInfo({
        providers: { spark: { models: { m1: { name: "M1 renamed" } } } },
      }).providers!.spark
      yield* catalog.setLayers(ProviderV2.ID.make("spark"), [info, rename])
      yield* catalog.setDefault("spark/m1")

      const view = (yield* ConfigStoreWrite.overlay({ username: "from-file", strict: { enabled: false } })) as {
        username?: string
        strict?: { enabled: boolean; attempts?: number }
        model?: string
        providers?: Record<string, { name?: string; models?: Record<string, { name?: string }> }>
      }
      expect(view.username).toBe("from-file") // untouched file key survives
      expect(view.strict).toEqual({ enabled: true, attempts: 3 }) // store wins over file
      expect(view.model).toBe("spark/m1")
      // Layer fold: base name survives, the later rename layer wins on the model name.
      expect(view.providers?.spark?.name).toBe("Spark")
      expect(view.providers?.spark?.models?.m1?.name).toBe("M1 renamed")
    }),
  )
})
