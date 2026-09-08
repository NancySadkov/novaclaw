import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { CommunityDht } from "@novaclaw/core/community/dht"
import { peers, scripted } from "./fixture/dht-sidecar"
import { Config } from "@novaclaw/core/config"
import { ConfigAgent } from "@novaclaw/core/config/agent"
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
        decodeProvider({
          api: { type: "native", settings: {}, url: "http://a/v1" },
          models: { "holo3.1": { name: "seeded" } },
        }),
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

  it.effect("REMOVING the governing agent's stored row is a repair, not a deletion", () =>
    Effect.gen(function* () {
      // The distinction that makes this safe: Nova is seeded in CODE, so dropping a stored override
      // row restores the shipped brief rather than deleting the colleague. Refusing it would leave a
      // stale row permanently unremovable through the API — the self-healing law failing quietly.
      // The identity is protected by the write refusal, by the materialiser, and by
      // `DELETE /api/agent/:id`; it does not need a fourth lock that only blocks repairs.
      const agents = yield* AgentConfigStore.Service
      // Written straight to the STORE: the write path now refuses this patch, which is the point —
      // the only way a `nova` row still exists is one that predates the refusal, and that is exactly
      // the row this repair has to be able to clear.
      yield* agents.setLayers("nova", [Schema.decodeUnknownSync(ConfigAgent.Info)({ description: "a stale override" })])

      yield* ConfigStoreWrite.remove([["agents", "nova"]])

      expect(Object.keys(yield* agents.agents())).not.toContain("nova")
    }),
  )

  it.effect("REFUSES a write naming the governing agent, and writes NOTHING", () =>
    Effect.gen(function* () {
      // The defect this closes, measured against a live instance 2026-08-21: the same patch answered
      // 200, stored a row, and had it dropped at materialisation — success reported for a change
      // that was discarded.
      const agents = yield* AgentConfigStore.Service
      const outcome = yield* Effect.exit(
        ConfigStoreWrite.apply(
          decodeInfo({ agents: { nova: { title: "HIJACKED" }, scribe: { description: "write things" } } }),
        ),
      )

      expect(outcome._tag).toBe("Failure")
      expect(JSON.stringify(outcome)).toContain("governing agent")
      // ALL-OR-NOTHING: the innocent sibling in the same patch must not have landed either, or a
      // refused request half-applies and the caller cannot tell which half.
      expect(Object.keys(yield* agents.agents())).toEqual([])
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
          providers: {
            "spark-holo": {
              api: { type: "native", settings: {}, url: "http://spark/v1" },
              models: { m: { name: "M" } },
            },
          },
        }),
      )

      let mcpReloads = 0
      let catalogReloads = 0
      let commandReloads = 0
      yield* ConfigStoreWrite.registerReload("mcp", () =>
        Effect.sync(() => {
          mcpReloads += 1
        }),
      )
      yield* ConfigStoreWrite.registerReload("catalog", () =>
        Effect.sync(() => {
          catalogReloads += 1
        }),
      )
      yield* ConfigStoreWrite.registerReload("commands", () =>
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
  /**
   * 🔴 **Codex review NC-SEC-011 — a REMOVAL that revokes nothing on the network.**
   *
   * `apply` settles the live DHT sidecar after a `community` (or `offline`) write, and its own
   * comment says why: the Kademlia node keeps running and republishes this instance's provider
   * record every 12 hours, so "the community is off" was a fact only the settings knew. `remove` —
   * the verb whose entire purpose is *"take this back"* — was the structural twin of `apply` in every
   * other respect and simply omitted that call, and its condition was missing `offline` too. So
   * deleting Community consent, or the published address, committed, answered 2xx, updated the UI,
   * and left the node serving and republishing the address the user had just deleted.
   *
   * Both paths now go through one `reconcileCommunity`, which is the point: two copies of a
   * post-commit settlement is how they drifted, so the fix is not a third copy.
   */
  it.live("🔴 removing Community WITHDRAWS the live DHT node, it does not just forget it", () =>
    Effect.gen(function* () {
      // One reply per request, in order: the announce, the lookup that follows it, and the withdraw.
      // ⚠️ A missing reply is not neutral — the layer reads an unanswered request as a WEDGED child
      // and kills it, which would stop the node for a reason that has nothing to do with the removal
      // and make this test pass while proving nothing.
      const sidecar = scripted([JSON.stringify({ announced: true }), peers([]), JSON.stringify({ announced: false })])
      yield* Effect.gen(function* () {
        yield* ConfigStoreWrite.apply(
          decodeInfo({ community: { consented: true, enabled: true, announce: "1.2.3.4:4096" } }),
        )
        // Publish for real, so there IS a live child to revoke — a settlement against a node that was
        // never started is a no-op and would prove nothing.
        const dht = yield* CommunityDht.Service
        yield* dht.find({ announce: "1.2.3.4:4096" })
        expect(sidecar.state.starts, "the fixture never started a node — the rest asserts nothing").toBe(1)
        expect(sidecar.state.stopped).toBe(0)

        yield* ConfigStoreWrite.remove([["community"]])

        // ⚠️ WITHDRAWN, not merely killed. There is no unpublish in Kademlia: killing the child
        // without withdrawing leaves the replicated copies to be found for the rest of their TTL
        // while we are not even running.
        expect(
          sidecar.state.written.at(-1),
          "the removal committed and answered success while the node kept advertising",
        ).toBe(JSON.stringify({ op: "withdraw" }))
        expect(sidecar.state.stopped, "the node nobody authorises any more must stop").toBe(1)
      }).pipe(Effect.provide(CommunityDht.layerWith({ start: sidecar.start, timeoutMs: 200 })))
    }).pipe(Effect.scoped),
  )

  /**
   * ⚠️ **The negative control, and it is the half that decides whether this is a settlement or a
   * blanket teardown.** Reconciling on every removal would pass the test above and would also stop a
   * healthy node whenever anyone deleted an unrelated key.
   */
  it.live("an unrelated removal touches the DHT node not at all", () =>
    Effect.gen(function* () {
      // Announce + the lookup after it. Nothing else should ever be written — see below.
      const sidecar = scripted([JSON.stringify({ announced: true }), peers([])])
      yield* Effect.gen(function* () {
        yield* ConfigStoreWrite.apply(
          decodeInfo({ community: { consented: true, enabled: true, announce: "1.2.3.4:4096" }, mcp: MCP_TWO }),
        )
        const dht = yield* CommunityDht.Service
        yield* dht.find({ announce: "1.2.3.4:4096" })
        expect(sidecar.state.starts).toBe(1)

        yield* ConfigStoreWrite.remove([["mcp", "servers", "weather"]])
        expect(sidecar.state.stopped, "an unrelated key removal stopped a healthy community node").toBe(0)
        expect(sidecar.state.written.some((line) => line.includes("withdraw"))).toBe(false)
      }).pipe(Effect.provide(CommunityDht.layerWith({ start: sidecar.start, timeoutMs: 200 })))
    }).pipe(Effect.scoped),
  )
})
