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

  it.effect("folds a provider patch into the stored layer and sets the default model", () =>
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

      // The patch collapses INTO the stored layer instead of appending a second one, and the fold is
      // patch-merge: the renamed model wins while the untouched `name` survives.
      const layers = (yield* catalog.providers())["spark"]!
      expect(layers).toHaveLength(1)
      expect(layers[0]?.models?.["m1"]?.name).toBe("M1 renamed")
      expect(layers[0]?.name).toBe("Spark")
      expect(yield* catalog.getDefault()).toBe("spark/m1")
    }),
  )

  // The regression that matters: layers used to grow one per save, unbounded — a dev instance reached
  // 12 for a single provider, and repeated edits of one field piled up as dead history.
  it.effect("repeated saves leave the layer count at one, newest value winning", () =>
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      const write = (budget: number) =>
        ConfigStoreWrite.apply(
          decodeInfo({
            providers: {
              spark: { name: "Spark", models: { m1: { name: "M1", request: { body: { thinkingBudget: budget } } } } },
            },
          }),
        )

      for (const budget of [6000, 8000, 12000]) yield* write(budget)

      const layers = (yield* catalog.providers())["spark"]!
      expect(layers).toHaveLength(1)
      expect(layers[0]?.models?.["m1"]?.request?.body?.["thinkingBudget"]).toBe(12000)
    }),
  )

  it.effect("agents, commands and references collapse the same way", () =>
    Effect.gen(function* () {
      const agents = yield* AgentConfigStore.Service
      const commands = yield* CommandConfigStore.Service
      const references = yield* ReferenceConfigStore.Service

      for (const tag of ["first", "second"]) {
        yield* ConfigStoreWrite.apply(
          decodeInfo({
            agents: { build: { description: `agent ${tag}` } },
            commands: { deploy: { template: `run ${tag}` } },
            references: { docs: { path: `/docs/${tag}` } },
          }),
        )
      }

      const agentLayers = (yield* agents.agents())["build"]!
      const commandLayers = (yield* commands.commands())["deploy"]!
      const referenceLayers = (yield* references.references())["docs"]!
      expect(agentLayers).toHaveLength(1)
      expect(commandLayers).toHaveLength(1)
      expect(referenceLayers).toHaveLength(1)
      expect(agentLayers[0]?.description).toBe("agent second")
      expect(commandLayers[0]?.template).toBe("run second")
    }),
  )

  // Folding must not silently drop the accumulated history's earlier values: an entity written before
  // the fix carries many layers, and the first write after it collapses them all into the same value
  // the served view was already showing.
  it.effect("collapses a pre-existing accumulated stack on the next write", () =>
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      const layerOf = (fragment: Record<string, unknown>) =>
        decodeInfo({ providers: { spark: fragment } }).providers!.spark
      yield* catalog.setLayers(ProviderV2.ID.make("spark"), [
        layerOf({ name: "Spark", models: { m1: { name: "M1" } } }),
        layerOf({ models: { m1: { request: { body: { min_p: 0.05 } } } } }),
        layerOf({ models: { m2: { name: "M2" } } }),
      ])

      yield* ConfigStoreWrite.apply(decodeInfo({ providers: { spark: { models: { m1: { name: "M1 final" } } } } }))

      const layers = (yield* catalog.providers())["spark"]!
      expect(layers).toHaveLength(1)
      expect(layers[0]?.name).toBe("Spark")
      expect(layers[0]?.models?.["m1"]?.name).toBe("M1 final")
      // From the middle layer — the same free-form request.body that carries thinkingBudget in the wild.
      expect(layers[0]?.models?.["m1"]?.request?.body?.["min_p"]).toBe(0.05)
      expect(layers[0]?.models?.["m2"]?.name).toBe("M2") // from the third layer, not lost
    }),
  )

  it.effect("replaces list stores wholesale (skills, plugins); step 9 routes the last settings keys", () =>
    Effect.gen(function* () {
      const skills = yield* SkillConfigStore.Service
      yield* skills.addSource("/old/skills")
      const plugins = yield* PluginConfigStore.Service
      yield* plugins.setPlugin({ package: "old-plugin" })

      // Step 9: instructions + disabled/enabled_providers joined SETTINGS_KEYS — every
      // Config.Info key now routes (nothing falls back to a jsonc patch anymore).
      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({
          skills: ["/new/skills"],
          plugins: ["new-plugin"],
          instructions: ["now-routed.md"],
          disabled_providers: ["x"],
        }),
      )
      expect([...consumed].sort()).toEqual(["disabled_providers", "instructions", "plugins", "skills"])
      expect(yield* skills.sources()).toEqual(["/new/skills"])
      expect(yield* plugins.plugins()).toEqual([{ package: "new-plugin" }])
      const settings = yield* SettingsConfigStore.Service
      const all = yield* settings.all()
      expect(all.instructions).toEqual(["now-routed.md"])
      expect(all.disabled_providers).toEqual(["x"])
    }),
  )
})

describe("ConfigStoreWrite export→import round-trip (step 8)", () => {
  it.effect("overlay({}) exports the stores; wiping and re-importing reproduces the same document", () =>
    Effect.gen(function* () {
      // Populate every store the way real usage does.
      yield* ConfigStoreWrite.apply(
        decodeInfo({
          shell: "pwsh",
          strict: { enabled: true, attempts: 2 },
          model: "spark/m1",
          default_agent: "build",
          providers: { spark: { name: "Spark", models: { m1: { name: "M1" } } } },
          agents: { build: { description: "the builder" } },
          commands: { review: { template: "review it" } },
          references: { docs: "https://github.com/example/docs.git" },
          skills: ["/opt/skills"],
          plugins: ["team-plugin@1.0.0", { package: "/opt/plugins/local.js", options: { x: 1 } }],
        }),
      )
      // A second provider patch: the export must FOLD the two layers into one fragment.
      yield* ConfigStoreWrite.apply(decodeInfo({ providers: { spark: { models: { m1: { name: "M1 v2" } } } } }))

      const exported = yield* ConfigStoreWrite.overlay({})
      expect((exported.providers as Record<string, { models: Record<string, { name: string }> }>).spark.models.m1.name).toBe("M1 v2")

      // Wipe every store (a fresh instance), then import the exported document via the router.
      const catalog = yield* CatalogStore.Service
      for (const id of Object.keys(yield* catalog.providers())) yield* catalog.removeProvider(ProviderV2.ID.make(id))
      const agents = yield* AgentConfigStore.Service
      for (const name of Object.keys(yield* agents.agents())) yield* agents.removeAgent(name)
      const commands = yield* CommandConfigStore.Service
      for (const name of Object.keys(yield* commands.commands())) yield* commands.removeCommand(name)
      const references = yield* ReferenceConfigStore.Service
      for (const name of Object.keys(yield* references.references())) yield* references.removeReference(name)
      const skills = yield* SkillConfigStore.Service
      for (const source of yield* skills.sources()) yield* skills.removeSource(source)
      const plugins = yield* PluginConfigStore.Service
      for (const entry of yield* plugins.plugins()) yield* plugins.removePlugin(entry.package)
      const settings = yield* SettingsConfigStore.Service
      for (const key of Object.keys(yield* settings.all())) yield* settings.remove(key)

      yield* ConfigStoreWrite.apply(decodeInfo(exported))
      const reimported = yield* ConfigStoreWrite.overlay({})
      expect(reimported).toEqual(exported)
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
