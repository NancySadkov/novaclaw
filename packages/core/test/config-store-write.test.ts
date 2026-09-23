import { describe, expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { LogSettings } from "@novaclaw/core/observability/log-settings"
import { Nudge } from "@novaclaw/core/nudge"
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
      ReferenceConfigStore.node,
      SettingsConfigStore.node,
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
  it.effect("routes log settings and updates the already-running hot-path projection", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* ConfigStoreWrite.apply(
        decodeInfo({ log: { level: "warn", retention_days: 90, subsystems: { mcp: "debug" } } }),
      )
      expect((yield* settings.all()).log).toEqual({
        level: "warn",
        retention_days: 90,
        subsystems: { mcp: "debug" },
      })
      expect(LogSettings.level()).toBe("warn")
      expect(LogSettings.maxAgeMs()).toBe(90 * 24 * 60 * 60 * 1000)

      // A partial PATCH keeps siblings, while the live projection changes with the same write.
      yield* ConfigStoreWrite.apply(decodeInfo({ log: { level: "error" } }))
      expect((yield* settings.all()).log).toEqual({
        level: "error",
        retention_days: 90,
        subsystems: { mcp: "debug" },
      })
      expect(LogSettings.level()).toBe("error")
      yield* settings.remove("log")
    }),
  )

  it.effect("routes settings keys with merge-in-place and reports consumed keys", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("telemetry", { enabled: true, retained: { source: "manual" } })

      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({
          telemetry: { enabled: false },
          snapshots: false,
          model_order: ["spark/m2", "spark/m1"],
          officer_order: ["theron", "aris"],
        }),
      )
      expect([...consumed].sort()).toEqual(["model_order", "officer_order", "snapshots", "telemetry"])

      const all = yield* settings.all()
      expect(all.telemetry).toEqual({ enabled: false, retained: { source: "manual" } })
      expect(all.snapshots).toBe(false)
      // `SettingsConfigStore` reads the runtime_setting SQLite table. This is the persistence gate:
      // ordering is instance data, not a browser-only preference that another client contradicts.
      expect(all.model_order).toEqual(["spark/m2", "spark/m1"])
      expect(all.officer_order).toEqual(["theron", "aris"])
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

  it.effect("routes the settings key (disabled_providers)", () =>
    Effect.gen(function* () {
      // Every Config.Info key routes; nothing falls back to a jsonc patch anymore.
      // `instructions` left SETTINGS_KEYS 2026-09-17 with the AGENTS.md auto-embed.
      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({
          disabled_providers: ["x"],
        }),
      )
      expect([...consumed].sort()).toEqual(["disabled_providers"])
      const settings = yield* SettingsConfigStore.Service
      const all = yield* settings.all()
      expect(all.disabled_providers).toEqual(["x"])
    }),
  )

  // Models-primary (notes/models-primary-plan.md P1/P2). `models` is a DECLARED `Config.Info` key
  // (config.ts) that routed NOWHERE: `updateConfig({models})` decoded cleanly, consumed nothing and
  // answered 200 for a write that vanished — the exact shape v0.2.0 ruling 2 outlaws ("a failed
  // mutation never reports success"). It routes through the SAME flat→nested expansion the jsonc
  // seed applies (`CatalogSeed.expandFlatModels`), so a PATCH and an import of the same document
  // land identically.
  it.effect("routes the models-primary `models` map into the catalog store", () =>
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({
          model: "qwen3.6-35b",
          models: { "qwen3.6-35b": { url: "http://10.0.0.5:8000/v1", name: "Qwen", taxonomy: "smart" } },
        }),
      )
      expect([...consumed].sort()).toEqual(["model", "models"])

      // The endpoint HOST is the internal provider group (the seed's rule), and the flat entry's
      // non-`url` fields become the nested model.
      const layers = (yield* catalog.providers())["10.0.0.5:8000"]
      expect(layers).toHaveLength(1)
      expect(layers?.[0]?.api?.url).toBe("http://10.0.0.5:8000/v1")
      expect(layers?.[0]?.models?.["qwen3.6-35b"]?.name).toBe("Qwen")
      // A bare default-model id naming a flat model expands to `providerID/modelID`, or the stored
      // default would address a provider that does not exist.
      expect(yield* catalog.getDefault()).toBe("10.0.0.5:8000/qwen3.6-35b")
    }),
  )

  // Ruling 2, the ATOMICITY half. `apply` writes to several stores; before the transaction those were
  // independent writes, so a failure part-way left the earlier ones committed.
  //
  // ⚠️ The failure is injected into `references`, the LAST layered arm `applyToStores` runs — so it
  // lands after the settings writes AND the earlier layered arms have already written. (It used to
  // be the `skills` list arm, which went with the skills subsystem on 2026-09-17.)
  it.effect("a mid-apply failure rolls back every earlier store write", () =>
    Effect.gen(function* () {
      const references = yield* ReferenceConfigStore.Service
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("snapshots", false)
      yield* settings.set("log", { level: "info" })
      yield* settings.all() // hydrate the synchronous log projection from the committed baseline

      // Real store for the reads; the write dies. Un-transacted, the two settings writes would
      // already be committed by the time it does.
      const failingReferences = ReferenceConfigStore.Service.of({
        references: () => references.references(),
        removeReference: (name) => references.removeReference(name),
        isEmpty: () => references.isEmpty(),
        setLayers: () => Effect.die(new Error("reference store write failed")),
      })

      const exit = yield* ConfigStoreWrite.apply(
        decodeInfo({
          snapshots: true,
          log: { level: "error" },
          references: { docs: "https://git.example.test/example/docs.git" },
        }),
      ).pipe(Effect.provideService(ReferenceConfigStore.Service, failingReferences), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      // Nothing the failed patch touched survives.
      expect((yield* settings.all()).snapshots).toBe(false)
      expect(LogSettings.level()).toBe("info")
      expect(yield* references.references()).toEqual({})
    }),
  )
})

describe("ConfigStoreWrite export→import round-trip (step 8)", () => {
  it.effect("overlay({}) exports the stores; wiping and re-importing reproduces the same document", () =>
    Effect.gen(function* () {
      // Populate every store the way real usage does.
      yield* ConfigStoreWrite.apply(
        decodeInfo({
          snapshots: false,
          strict: { enabled: true, attempts: 2 },
          model: "spark/m1",
          default_agent: "build",
          providers: { spark: { name: "Spark", models: { m1: { name: "M1" } } } },
          agents: { build: { description: "the builder" } },
          commands: { review: { template: "review it" } },
          references: { docs: "https://git.example.test/example/docs.git" },
        }),
      )
      // A second provider patch: the export must FOLD the two layers into one fragment.
      yield* ConfigStoreWrite.apply(decodeInfo({ providers: { spark: { models: { m1: { name: "M1 v2" } } } } }))

      const exported = yield* ConfigStoreWrite.overlay({})
      expect(
        (exported.providers as Record<string, { models: Record<string, { name: string }> }>).spark.models.m1.name,
      ).toBe("M1 v2")

      // Wipe every store (a fresh instance), then import the exported document via the router.
      const catalog = yield* CatalogStore.Service
      for (const id of Object.keys(yield* catalog.providers())) yield* catalog.removeProvider(ProviderV2.ID.make(id))
      const agents = yield* AgentConfigStore.Service
      for (const name of Object.keys(yield* agents.agents())) yield* agents.removeAgent(name)
      const commands = yield* CommandConfigStore.Service
      for (const name of Object.keys(yield* commands.commands())) yield* commands.removeCommand(name)
      const references = yield* ReferenceConfigStore.Service
      for (const name of Object.keys(yield* references.references())) yield* references.removeReference(name)
      const settings = yield* SettingsConfigStore.Service
      for (const key of Object.keys(yield* settings.all())) yield* settings.remove(key)

      yield* ConfigStoreWrite.apply(decodeInfo(exported))
      const reimported = yield* ConfigStoreWrite.overlay({})
      expect(reimported).toEqual(exported)
    }),
  )
})

describe("ConfigStoreWrite.overlay", () => {
  it.effect("shows officer Nudges in settings without adding them to stored export", () =>
    Effect.gen(function* () {
      const agents = yield* AgentConfigStore.Service
      yield* agents.setLayers("postal", [Schema.decodeUnknownSync(ConfigAgent.Info)({ title: "Postal agent" })])
      const stored = (yield* ConfigStoreWrite.overlay({})) as { agents?: Record<string, { nudges?: unknown[] }> }
      const settings = (yield* ConfigStoreWrite.overlay({}, "settings")) as {
        agents?: Record<string, { nudges?: { id: string }[] }>
      }
      expect(stored.agents?.nova).toBeUndefined()
      expect(stored.agents?.postal?.nudges).toBeUndefined()
      expect(settings.agents?.nova?.nudges?.map((item) => item.id)).toEqual(Nudge.defaults().map((item) => item.id))
      expect(settings.agents?.postal?.nudges?.map((item) => item.id)).toEqual(Nudge.defaults().map((item) => item.id))
    }),
  )

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
