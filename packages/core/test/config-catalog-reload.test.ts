import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { Catalog } from "@novaclaw/core/catalog"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Config } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Integration } from "@novaclaw/core/integration"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ProviderV2 } from "@novaclaw/core/provider"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// ────────────────────────────────────────────────────────────────────────────────────────────────
// v0.2.0-prep B7 (FINAL) / ruling 3 — the CATALOG half of *a settings change is not a reboot*.
//
// `config-domain-reload.test.ts` (tier-2c) pins four materialised domains — agents · commands ·
// references · skills. It does NOT cover `catalog`/`integration`, and those are materialised exactly
// the same way: `config/plugin/provider.ts` registers a `ctx.catalog.transform` + a
// `ctx.integration.transform` that read `CatalogStore` at location boot, and `state.ts` re-runs a
// transform only on an explicit `.reload()`.
//
// That made them load-bearing for the FINAL step of B7 — dropping `markInstanceForDisposal` from the
// config write path — rather than a nice-to-have. Until this landed, the only thing that made an
// edited provider take effect was the whole layer graph being destroyed, so removing the teardown
// would have broken AGENTS.md's own self-healing example verbatim: *"a lay user whose provider moved
// its servers just asks any still-working model to fix it (one PATCH updates
// `providers.<id>.api.url`), no restart"*.
//
// ⚠️ MEASURED before the fix (2026-07-31, this file as a probe): the write commits and the store
// reports the provider (`store layers: ["b7-catalog-probe"]`), while the location's already-built
// `Catalog` answers `undefined` — i.e. a settings change that silently does nothing until reboot,
// with every other test in the tree green. That is the negative control for this file, and it is the
// exact defect class B7 exists to remove, so it must never come back.
//
// ⚠️ Read-through shape, same as the tier-2c file: `Catalog.Service` is resolved ONCE, before the
// write, and every assertion afterwards goes through that same instance. Re-resolving after the
// write would pass even with the domain frozen at boot.
// ────────────────────────────────────────────────────────────────────────────────────────────────

// Nothing here wants a real OS watch; the watcher has its own wiring test.
const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER: "true" }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SettingsConfigStore.node,
      CatalogStore.node,
      AgentConfigStore.node,
      CommandConfigStore.node,
      ReferenceConfigStore.node,
      SkillConfigStore.node,
      PluginConfigStore.node,
      LocationServiceMap.node,
    ]),
  ).pipe(Layer.provide(flagsLayer)),
)

const decodeInfo = Schema.decodeUnknownSync(Config.Info)

const PROBE = "b7-catalog-probe"
const PROBE_ID = ProviderV2.ID.make(PROBE)
const api = (url: string) => ({ type: "aisdk", package: "@ai-sdk/openai-compatible", url }) as const

const withLocation = <A, E, R>(body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))))

describe("a provider write re-materialises the catalog", () => {
  it.live("an edited PROVIDER endpoint is live on the same Catalog instance — no layer rebuild", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          // `ready` is the boot latch: `PluginInternal` forks its registration batch and defers the
          // State reloads to the end of it. Waiting on it is how we know the initial materialisation
          // has settled before we measure — not a sleep.
          const plugins = yield* PluginV2.Service
          yield* plugins.ready

          // Resolved ONCE. See the read-through note at the top of the file.
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          expect(yield* catalog.provider.get(PROBE_ID)).toBeUndefined()

          const dispatchedBefore = ConfigStoreWrite.reloadsDispatched("catalog")
          // `config/plugin/provider.ts` registers exactly one reload per open location. Zero here
          // would mean the wiring is gone and every assertion below passes for the wrong reason.
          expect(ConfigStoreWrite.registeredReloads("catalog")).toBeGreaterThan(0)

          // The exact path `PATCH /config`, Settings → Import and (soon) the `configure` tool take.
          // Nothing is rebuilt after it, and no location is reopened.
          const started = performance.now()
          yield* ConfigStoreWrite.apply(
            decodeInfo({
              providers: { [PROBE]: { name: "Probe endpoint", api: api("https://before.test/v1") } },
            }),
          )
          const elapsed = performance.now() - started
          expect((yield* catalog.provider.get(PROBE_ID))?.api?.url).toBe("https://before.test/v1")

          // AGENTS.md's self-healing example verbatim: the vendor moved its servers and an agent
          // repairs the instance with one PATCH. A reload that only ever runs once (or a
          // materialisation that caches) passes the assertion above and fails here.
          yield* ConfigStoreWrite.apply(decodeInfo({ providers: { [PROBE]: { api: api("https://after.test/v1") } } }))
          expect((yield* catalog.provider.get(PROBE_ID))?.api?.url).toBe("https://after.test/v1")

          // The INTEGRATION half, which rides the same registration: a provider declaring `env`
          // names must produce an integration record, or `catalog.provider.available()` reports the
          // provider the user just added as unavailable.
          yield* ConfigStoreWrite.apply(
            decodeInfo({ providers: { [PROBE]: { env: ["B7_PROBE_KEY"], api: api("https://after.test/v1") } } }),
          )
          expect((yield* integrations.list()).map((entry) => String(entry.id))).toContain(PROBE)

          // …and exactly one reload per write per location: the guard is per-key, not per-write.
          expect(ConfigStoreWrite.reloadsDispatched("catalog") - dispatchedBefore).toBe(3)

          // Printed, deliberately NOT asserted — the same reasoning as the tier-2c file: a
          // wall-clock ceiling loose enough not to flake on a loaded box is also loose enough to
          // pass if someone wired a full location rebuild into the reload path. The dispatch count
          // above is the assertion that catches that.
          console.log(`[measure] config write + catalog re-materialise: ${elapsed.toFixed(1)} ms`)
        }).pipe(Effect.provide(LocationServiceMap.Service.get(location))),
      ),
    ),
  )
})

describe("the catalog reload is per-key, like every other domain", () => {
  it.effect("an unrelated config key re-materialises the catalog exactly zero times", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      yield* ConfigStoreWrite.registerReload("catalog", () =>
        Effect.sync(() => {
          seen.push("catalog")
        }),
      )

      // A reload fired on "something was written" rather than on the key would show up here. It is
      // not merely wasteful for this domain: the registration chains an `integration.reload()`, and
      // integrations are what carry credential/connection state.
      yield* ConfigStoreWrite.apply(decodeInfo({ shell: "/bin/churn-probe" }))
      expect(seen).toEqual([])

      yield* ConfigStoreWrite.apply(decodeInfo({ providers: { [PROBE]: { name: "n" } } }))
      expect(seen).toEqual(["catalog"])

      // `models` is the FLAT authoring shape and expands into provider groups, so it leaves the
      // catalog just as stale as `providers` does; `model` writes the default-model row.
      yield* ConfigStoreWrite.apply(decodeInfo({ models: { "b7-flat": { url: "https://flat.test/v1" } } }))
      expect(seen).toEqual(["catalog", "catalog"])
    }),
  )

  it.effect("`catalog` is a declared reload domain, not a string that happens to work", () =>
    Effect.sync(() => {
      // `registerReload` indexes a record keyed by `ReloadDomain`. If `catalog` ever left
      // `RELOAD_DOMAINS`, the registration above would throw rather than silently no-op — but the
      // declaration is what `staleDomains` iterates, so pin it directly the way
      // `config-routing-ledger.test.ts` pins the router.
      expect(ConfigStoreWrite.RELOAD_DOMAINS).toContain("catalog")
    }),
  )
})
