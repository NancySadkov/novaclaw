import { describe, expect } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
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

  it.effect("replaces the list store wholesale (skills); step 9 routes the last settings keys", () =>
    Effect.gen(function* () {
      const skills = yield* SkillConfigStore.Service
      yield* skills.addSource("/old/skills")

      // Step 9: instructions + disabled_providers joined SETTINGS_KEYS — every
      // Config.Info key now routes (nothing falls back to a jsonc patch anymore).
      const consumed = yield* ConfigStoreWrite.apply(
        decodeInfo({
          skills: ["/new/skills"],
          instructions: ["now-routed.md"],
          disabled_providers: ["x"],
        }),
      )
      expect([...consumed].sort()).toEqual(["disabled_providers", "instructions", "skills"])
      expect(yield* skills.sources()).toEqual(["/new/skills"])
      const settings = yield* SettingsConfigStore.Service
      const all = yield* settings.all()
      expect(all.instructions).toEqual(["now-routed.md"])
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
          models: { "qwen3.6-35b": { url: "http://10.0.0.5:8000/v1", name: "Qwen", tier: "large" } },
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

  // Ruling 2, the ATOMICITY half. `apply` writes to seven stores; before the transaction those were
  // seven independent writes, so a failure at step 5 left steps 1-4 committed. Worse, the list store
  // is wipe-then-reinsert, so a failure between the two loops left it EMPTY.
  //
  // ⚠️ Both failures below are injected into `skills`, the LAST arm `applyToStores` runs — so each
  // one lands after every other store has already written. It used to be `plugins`; that arm and its
  // store went with the `plugins[]` key under ruling 5 / step 17. **If a new list arm is ever
  // appended after `skills`, move these injections onto it** or they stop testing "last".
  it.effect("a mid-apply failure rolls back every earlier store write", () =>
    Effect.gen(function* () {
      const skills = yield* SkillConfigStore.Service
      const settings = yield* SettingsConfigStore.Service
      yield* skills.addSource("/survives/skills")
      yield* settings.set("shell", "before-the-failed-write")
      yield* settings.set("log", { level: "info" })
      yield* settings.all() // hydrate the synchronous log projection from the committed baseline
      const skillsBefore = yield* skills.sources()

      // Real store for the reads and the DELETE loop; the FIRST insert dies. Un-transacted, the two
      // settings writes AND the skills delete are already committed by the time it does.
      const failingSkills = SkillConfigStore.Service.of({
        sources: () => skills.sources(),
        removeSource: (source) => skills.removeSource(source),
        isEmpty: () => skills.isEmpty(),
        addSource: () => Effect.die(new Error("skill store write failed")),
      })

      const exit = yield* ConfigStoreWrite.apply(
        decodeInfo({
          shell: "after-the-failed-write",
          log: { level: "error" },
          skills: ["/replacement/skills"],
        }),
      ).pipe(Effect.provideService(SkillConfigStore.Service, failingSkills), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      // Nothing the failed patch touched survives — not the settings write, and (the sharp edge)
      // not the skills DELETE that ran before the failure.
      expect(yield* skills.sources()).toEqual(skillsBefore)
      expect((yield* settings.all()).shell).toBe("before-the-failed-write")
      expect(LogSettings.level()).toBe("info")
    }),
  )

  // The same invariant one step deeper: the failure lands INSIDE the reinsert loop, after the delete
  // loop has emptied the table AND after the first replacement row is already in.
  it.effect("the skills wipe-then-reinsert is atomic — a failure mid-loop restores the stored list", () =>
    Effect.gen(function* () {
      const skills = yield* SkillConfigStore.Service
      yield* ConfigStoreWrite.apply(decodeInfo({ skills: ["/keeper-a", "/keeper-b"] }))
      const before = yield* skills.sources()
      expect(before).toEqual(["/keeper-a", "/keeper-b"])

      // Real store for the reads and the DELETE loop; only the SECOND insert dies.
      let inserts = 0
      const flaky = SkillConfigStore.Service.of({
        sources: () => skills.sources(),
        removeSource: (source) => skills.removeSource(source),
        isEmpty: () => skills.isEmpty(),
        addSource: (source) =>
          ++inserts === 2 ? Effect.die(new Error("skill insert failed")) : skills.addSource(source),
      })

      const exit = yield* ConfigStoreWrite.apply(decodeInfo({ skills: ["/new-a", "/new-b"] })).pipe(
        Effect.provideService(SkillConfigStore.Service, flaky),
        Effect.exit,
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* skills.sources()).toEqual(before)
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
          references: { docs: "https://git.example.test/example/docs.git" },
          skills: ["/opt/skills"],
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
      const skills = yield* SkillConfigStore.Service
      for (const source of yield* skills.sources()) yield* skills.removeSource(source)
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
