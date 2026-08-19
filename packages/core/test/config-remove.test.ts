import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigProvider } from "@novaclaw/core/config/provider"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { testEffect } from "./lib/effect"

/**
 * ═══ v0.2.0 item 4.3 — the config DELETION verb ══════════════════════════════════════════════════
 *
 * `PATCH /config` merges and never deletes; `null` is a value there, not a tombstone (the argument
 * is at the top of `merge-patch.ts`). `ConfigStoreWrite.remove` is the second verb, and this file
 * drives it against a REAL SQLite store rather than a re-implementation of the rule.
 *
 * **The two live defects it was built for**, both filed 🔴 and both exercised below by name:
 *  · a stale catalog MODEL could only be removed by deleting its whole provider (twelve models went
 *    with one on 2026-08-06) — `DELETE /api/provider/:id/model` closed the catalogue case on the
 *    same day; this closes the general one, so the two now agree on layer semantics because they
 *    share `MergePatch.removeAt`;
 *  · `mcp.servers.<name>` had no removal path at all — no null-deletion, no route, no store op.
 *
 * ⚠️ **The sharpest test in this file is `strips a model from EVERY stored layer`.** A layered
 * entity's served value is a positional left fold, so pruning only the newest layer lets the seeded
 * layer underneath resurrect the entry on the next read: a delete that returns success and then
 * undoes itself. That is the failure a per-key hand-written removal would most plausibly ship.
 */

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
const decodeProvider = Schema.decodeUnknownSync(ConfigProvider.Info)

/** Two MCP servers, so a removal has a bystander to leave alone. */
const MCP_TWO = {
  servers: {
    filesystem: { type: "local", command: ["npx", "mcp-filesystem"] },
    weather: { type: "remote", url: "https://example.invalid/mcp" },
  },
}

/**
 * Run a removal that is expected to be refused, and hand back the TYPED refusal.
 *
 * ⚠️ `Effect.flip` rather than `Effect.exit`, and that choice is the assertion, twice over.
 * `flip` surfaces only the TYPED error channel: a DEFECT stays a defect and fails the test loudly,
 * and a removal that wrongly SUCCEEDS fails it too (the flipped effect fails with the report). That
 * matters because `remove` deliberately routes a caller's bad path through the error channel so the
 * HTTP layer can answer 400 — if it ever started dying instead, the same typo would become a 500,
 * i.e. us blaming the caller's mistake on ourselves. An `exit`-based helper accepts both and would
 * have swallowed the regression. (`Effect.either` does not exist on effect@4.0.0-beta.83.)
 */
const refusalOf = (paths: readonly (readonly string[])[]) =>
  Effect.gen(function* () {
    const refused = yield* Effect.flip(ConfigStoreWrite.remove(paths))
    expect(refused.refusals.length, "the failure must name every offending path").toBeGreaterThan(0)
    return refused
  })

describe("ConfigStoreWrite.remove — the two 🔴 defects", () => {
  it.effect("🔴 removes ONE mcp.servers entry and leaves its sibling", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("mcp", MCP_TWO)

      const report = yield* ConfigStoreWrite.remove([["mcp", "servers", "weather"]])
      expect(report.removed).toEqual([["mcp", "servers", "weather"]])

      // Re-READ the store rather than trust the return value — the whole point of the item.
      const after = (yield* settings.all()).mcp as { servers: Record<string, unknown> }
      expect(Object.keys(after.servers)).toEqual(["filesystem"])
    }),
  )

  it.effect("🔴 removes ONE catalog model and keeps the provider and its siblings", () =>
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      yield* ConfigStoreWrite.apply(
        decodeInfo({
          providers: {
            "spark-holo": {
              api: { type: "native", settings: {}, url: "http://spark-0693.local:8010/v1" },
              models: { "holo3.1": { name: "Holo 3.1" }, "holo3.0": { name: "Holo 3.0" } },
            },
          },
        }),
      )

      yield* ConfigStoreWrite.remove([["providers", "spark-holo", "models", "holo3.1"]])

      const layers = yield* catalog.providers()
      const provider = layers["spark-holo"]
      // The provider SURVIVES — it carries the endpoint URL, which is the expensive hand-authored
      // part and not what someone pruning one entry asked to lose (`model-prune.ts` documents this).
      expect(provider, "removing a model must not remove its provider").toBeDefined()
      expect(Object.keys(provider![0]!.models ?? {})).toEqual(["holo3.0"])
      expect(provider![0]!.api).toBeDefined()
    }),
  )
})

describe("ConfigStoreWrite.remove — layer semantics", () => {
  /**
   * ⚠️ The resurrection control. Both layers carry the model; stripping only the last one leaves the
   * fold serving it again on the next read.
   */
  it.effect("strips a model from EVERY stored layer, not just the newest", () =>
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      const id = ProviderV2.ID.make("spark-holo")
      yield* catalog.setLayers(id, [
        decodeProvider({ api: { type: "native", settings: {}, url: "http://a/v1" }, models: { "holo3.1": { name: "seeded" } } }),
        decodeProvider({ models: { "holo3.1": { name: "edited" }, keep: { name: "keep" } } }),
      ])

      yield* ConfigStoreWrite.remove([["providers", "spark-holo", "models", "holo3.1"]])

      const layers = (yield* catalog.providers())["spark-holo"]!
      expect(layers).toHaveLength(2)
      // ⚠️ `Object.keys(...).not.toContain(...)`, NOT `expect(models).not.toHaveProperty("holo3.1")`.
      // A negative control caught this line being vacuous: bun's `toHaveProperty` reads a dotted
      // string as a PATH, so it looked for `.holo3` → `.1`, found neither, and passed while the
      // model was sitting right there. That is this item's own trap — the reason a removal path is a
      // segment ARRAY — reproduced inside the test written to pin it. Assert on the key list.
      for (const [index, layer] of layers.entries())
        expect(Object.keys(layer.models ?? {}), `layer ${index} still carries the model`).not.toContain("holo3.1")
      // The layer count is unchanged even where a layer became model-less: a layer carries more than
      // its `models` map and the fold is positional, so dropping an emptied layer would change how
      // the remaining ones combine.
      expect(layers[1]!.models).toEqual({ keep: { name: "keep" } } as never)
    }),
  )

  it.effect("removes a whole layered entity by name", () =>
    Effect.gen(function* () {
      const agents = yield* AgentConfigStore.Service
      yield* ConfigStoreWrite.apply(
        decodeInfo({ agents: { reviewer: { description: "r" }, builder: { description: "b" } } }),
      )

      yield* ConfigStoreWrite.remove([["agents", "reviewer"]])

      expect(Object.keys(yield* agents.agents())).toEqual(["builder"])
    }),
  )

  it.effect("refuses to wipe a whole layered KEY at once — the blast radius must be named", () =>
    Effect.gen(function* () {
      yield* ConfigStoreWrite.apply(decodeInfo({ agents: { reviewer: { description: "r" } } }))
      const refused = yield* refusalOf([["agents"]])
      expect(refused.refusals[0]!.kind).toBe("refused")
      expect(refused.message).toContain("name the entry")
      const agents = yield* AgentConfigStore.Service
      expect(Object.keys(yield* agents.agents())).toEqual(["reviewer"])
    }),
  )
})

describe("ConfigStoreWrite.remove — ruling 2: a failed removal never reports success", () => {
  it.effect("a path that names nothing fails, and NOTHING else is removed", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("mcp", MCP_TWO)

      const refused = yield* refusalOf([
        ["mcp", "servers", "filesystem"], // real
        ["mcp", "servers", "ghost"], // never existed
      ])
      expect(refused.refusals.map((refusal) => refusal.kind)).toEqual(["missing"])
      expect(refused.message).toContain("ghost")

      // All-or-nothing: the GOOD path rolled back with the bad one. A 2xx for "one of two" is what
      // makes a repair loop believe it has finished.
      const after = (yield* settings.all()).mcp as { servers: Record<string, unknown> }
      expect(Object.keys(after.servers).sort()).toEqual(["filesystem", "weather"])
    }),
  )

  it.effect("an empty path list is refused rather than reported as a successful no-op", () =>
    Effect.gen(function* () {
      const refused = yield* refusalOf([])
      expect(refused.refusals[0]!.reason).toContain("no paths were given")
    }),
  )

  it.effect("removing the same path twice: the second attempt is honest about being a no-op", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("mcp", MCP_TWO)
      yield* ConfigStoreWrite.remove([["mcp", "servers", "weather"]])
      const refused = yield* refusalOf([["mcp", "servers", "weather"]])
      expect(refused.refusals[0]!.kind).toBe("missing")
    }),
  )
})

describe("ConfigStoreWrite.remove — the refusal ledger redirects instead of shrugging", () => {
  it.effect("an ARRAY key names the merge that already deletes from it", () =>
    Effect.gen(function* () {
      const refused = yield* refusalOf([["skills", "some-skill"]])
      expect(refused.message).toContain("PATCH /config")
      expect(refused.message).toContain("replace wholesale")
    }),
  )

  it.effect("the flat `models` authoring shape names the stored path instead", () =>
    Effect.gen(function* () {
      const refused = yield* refusalOf([["models", "holo3.1"]])
      expect(refused.message).toContain('["providers", "<providerID>", "models", "<modelID>"]')
    }),
  )

  it.effect("an unknown top-level key is refused by name, not treated as missing", () =>
    Effect.gen(function* () {
      const refused = yield* refusalOf([["provider_preset", "x"]])
      expect(refused.refusals[0]!.kind).toBe("refused")
      expect(refused.message).toContain("is not a config key")
    }),
  )
})

describe("ConfigStoreWrite.remove — settings keys and default refs", () => {
  it.effect("removes a nested settings value and leaves the rest of the key", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("mcp", { timeout: { startup: 5000 }, servers: { a: { type: "local", command: ["a"] } } })
      yield* ConfigStoreWrite.remove([["mcp", "timeout", "startup"]])
      expect((yield* settings.all()).mcp).toEqual({ timeout: {}, servers: { a: { type: "local", command: ["a"] } } })
    }),
  )

  it.effect("removes a whole settings key", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("shell", "bash")
      yield* ConfigStoreWrite.remove([["shell"]])
      expect((yield* settings.all()).shell).toBeUndefined()
    }),
  )

  /** `default_agent` was WRITE-ONLY through the config surface until `clearDefault` existed — an
   *  empty string is still a value, so the ROW has to go. */
  it.effect("clears a default ref, and says so when there was none", () =>
    Effect.gen(function* () {
      const agents = yield* AgentConfigStore.Service
      yield* agents.setDefault("reviewer")
      yield* ConfigStoreWrite.remove([["default_agent"]])
      expect(yield* agents.getDefault()).toBeUndefined()

      const refused = yield* refusalOf([["default_agent"]])
      expect(refused.refusals[0]!.kind).toBe("missing")
    }),
  )
})

describe("ConfigStoreWrite.remove — a dangling default is pruned with its target", () => {
  it.effect("clears default_agent when it pointed at the removed agent, and only then", () =>
    Effect.gen(function* () {
      const agents = yield* AgentConfigStore.Service
      yield* ConfigStoreWrite.apply(
        decodeInfo({ agents: { reviewer: { description: "r" }, builder: { description: "b" } } }),
      )
      yield* agents.setDefault("reviewer")

      // Negative control FIRST: removing the OTHER agent must leave the default alone.
      yield* ConfigStoreWrite.remove([["agents", "builder"]])
      expect(yield* agents.getDefault()).toBe("reviewer")

      const report = yield* ConfigStoreWrite.remove([["agents", "reviewer"]])
      expect(yield* agents.getDefault()).toBeUndefined()
      expect(report.cleared).toEqual(["default_agent"])
    }),
  )

  it.effect("clears the default model when its model — or its whole provider — is removed", () =>
    Effect.gen(function* () {
      const catalog = yield* CatalogStore.Service
      yield* ConfigStoreWrite.apply(
        decodeInfo({
          providers: {
            "spark-holo": {
              api: { type: "native", settings: {}, url: "http://spark/v1" },
              models: { "holo3.1": { name: "Holo" }, "holo3.0": { name: "Old" } },
            },
          },
          model: "spark-holo/holo3.1",
        }),
      )

      // Negative control: a sibling model going does not touch the default.
      yield* ConfigStoreWrite.remove([["providers", "spark-holo", "models", "holo3.0"]])
      expect(yield* catalog.getDefault()).toBe("spark-holo/holo3.1")

      const report = yield* ConfigStoreWrite.remove([["providers", "spark-holo", "models", "holo3.1"]])
      expect(yield* catalog.getDefault()).toBeUndefined()
      expect(report.cleared).toEqual(["model"])
    }),
  )
})

describe("ConfigStoreWrite.remove — a removal is not a reboot (ruling 3)", () => {
  it.effect("fires the same domain reload a PATCH does, for the domains the removal made stale", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsConfigStore.Service
      yield* settings.set("mcp", MCP_TWO)
      yield* ConfigStoreWrite.apply(
        decodeInfo({
          providers: { "spark-holo": { api: { type: "native", settings: {}, url: "http://spark/v1" }, models: { m: { name: "M" } } } },
        }),
      )

      let mcpReloads = 0
      let catalogReloads = 0
      let commandReloads = 0
      yield* ConfigStoreWrite.registerReload(
        "mcp",
        () =>
          Effect.sync(() => {
            mcpReloads += 1
          }),
      )
      yield* ConfigStoreWrite.registerReload(
        "catalog",
        () =>
          Effect.sync(() => {
            catalogReloads += 1
          }),
      )
      yield* ConfigStoreWrite.registerReload(
        "commands",
        () =>
          Effect.sync(() => {
            commandReloads += 1
          }),
      )

      yield* ConfigStoreWrite.remove([["mcp", "servers", "weather"]])
      expect(mcpReloads, "an mcp removal must re-materialise the mcp domain").toBe(1)
      // Per-key discipline, not a blanket flush: an unrelated domain costs nothing.
      expect(catalogReloads).toBe(0)
      expect(commandReloads).toBe(0)

      yield* ConfigStoreWrite.remove([["providers", "spark-holo", "models", "m"]])
      expect(catalogReloads).toBe(1)
      expect(commandReloads).toBe(0)
    }).pipe(Effect.scoped),
  )
})
