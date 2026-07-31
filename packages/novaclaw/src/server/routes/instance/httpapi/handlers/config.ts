import { Config } from "@/config/config"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { ProviderCatalogResult } from "@/provider/catalog-result"
import { Catalog } from "@novaclaw/core/catalog"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import * as InstanceState from "@/effect/instance-state"
import { Effect, Layer, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { rejectUnknownConfigKeys } from "../groups/config"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      // The success schema is the `Config.Info` Schema.Class, so the response must be a class
      // INSTANCE — the service returns a plain merged object (with the derived `plugin_origins`),
      // so decode it (excess `plugin_origins` is ignored) before returning.
      // Config→SQLite step 7: overlay the store-backed keys so per-location consumers
      // (`sync().data.config` — the composer's strict/tuning global defaults) read the same
      // values the runtime's synthetic document serves.
      const base = (yield* configSvc.get()) as Record<string, unknown>
      return Schema.decodeUnknownSync(ConfigV2.Info)(yield* ConfigStoreWrite.overlay(base))
    })

    // Config→SQLite step 9: settings are instance-wide, so the instance-scoped update routes
    // through the same store router as the global one (there is no per-instance config.json
    // anymore). `invalidate()` refreshes the service's cached store view.
    //
    // ─── v0.2.0-prep B7, FINAL STEP: a settings change is not a reboot (ruling 3) ─────────────────
    //
    // This handler used to end with `markInstanceForDisposal(...)`, which deferred an
    // `InstanceStore.dispose` to the post-response middleware: the instance was dropped from the
    // store, every `InstanceState` cache in the process was invalidated, and the whole per-location
    // layer graph was released. **Saving a preference killed the user's terminals, failed every
    // pending permission ask, and shut down every MCP child**, then paid a ~1 s location boot on the
    // next request. That was the only reason an edited setting applied at all — root cause S1: every
    // runtime-editable value was snapshotted at layer-build time, so the only repair was destroying
    // the layer graph.
    //
    // It is gone because the four cures that replace it are all in the tree, each read-through or
    // re-materialising at the write itself rather than at a rebuild:
    //   · tier-1   — `Config.entries()` reads through to the store; the runner derives harness config
    //                per turn, so every plain settings key is live with no invalidation at all.
    //   · tier-2a  — `tool/profile.ts` gates on a live per-turn availability predicate instead of a
    //                layer-scope snapshot.
    //   · tier-2b  — `filesystem/watcher.ts` RE-SUBSCRIBES on a `watcher.ignore` change (an OS
    //                subscription cannot be read through), fired from `ConfigStoreWrite.apply`.
    //   · tier-2c+ — the per-domain reload registry in `ConfigStoreWrite.apply` re-materialises the
    //                domains that are a built graph: agents · commands · references · skills, and
    //                (added with this step) the CATALOG, i.e. providers/models plus the integrations
    //                derived from them. Without that last one, dropping the teardown would have
    //                silently broken AGENTS.md's self-healing example — one PATCH fixing a moved
    //                provider URL, no restart. Measured, then fixed:
    //                `packages/core/test/config-catalog-reload.test.ts`.
    //
    // `Offline.reload()` rides the same chokepoint (A3), so the airgap applies immediately too.
    //
    // ⚠️ What is NOT yet live, so nobody reads this as "everything applies": the novaclaw-side
    // per-instance `InstanceState` caches (`Config`, `Agent`, `MCP`, `Skill`, `Format`) were also
    // refreshed by that teardown and have no other invalidation — `Config.invalidate()` clears only
    // the process-global store view, and there are ZERO callers of `InstanceState.invalidate` in the
    // tree. The keys behind them (`mcp` via a config import, `formatter`, `snapshots`, `plugins`)
    // still want a restart. They are tracked as B7 tier-3 rather than fixed here: their cure is a
    // per-service refresh registry like the one above, NOT a blanket cache flush — a blanket flush is
    // what shuts MCP children down and fails pending asks, i.e. this defect wearing a smaller
    // footprint. `GET /config` is unaffected either way: it answers from `ConfigStoreWrite.overlay`,
    // which reads the stores directly.
    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      // Ruling 2, FIRST: an unknown top-level key never survives the payload decode
      // (`onExcessProperty: "ignore"`), so it would answer 200 for a write that never happened.
      // Refuse on the wire, by name, before anything is attempted. Reasoning — including why the
      // FILE import path deliberately stays lenient, and the forward-compat cost — lives with the
      // guard in `../groups/config`.
      yield* rejectUnknownConfigKeys(ctx.request)
      const consumed = yield* ConfigStoreWrite.apply(ctx.payload)
      if (consumed.size > 0) yield* configSvc.invalidate()
      // Answer with what the STORES hold, never an echo of the request (ruling 2: a failed mutation
      // never reports success). An echo claims success for a key that did not route — `models` was
      // swallowed entirely until Wave 1 — and misreports a write whose stored shape differs from
      // what was sent, since `models` normalizes into `providers`. The sibling global route already
      // answers this way (handlers/global.ts:123-124); the two disagreed.
      //
      // The reply is now total as well as honest, in both directions: an entirely UNKNOWN key is
      // refused above by `rejectUnknownConfigKeys` (400, named), and a DECLARED key no store routes
      // faults inside `apply`'s transaction (`NOT_ROUTED_KEYS`). So a 200 here means every key in
      // the patch either landed or is a ledgered no-op — nothing was accepted and discarded.
      const base = (yield* configSvc.get()) as Record<string, unknown>
      return Schema.decodeUnknownSync(ConfigV2.Info)(yield* ConfigStoreWrite.overlay(base))
    })

    // Connected providers come from the V2 `Catalog` (available = has
    // credentials/integration), served as native catalog shapes. Catalog is
    // location-scoped — resolve it through the shared location-service map.
    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const available = yield* catalog.provider.available()
        const models = yield* catalog.model.all()
        return ProviderCatalogResult.listResult({
          providers: available,
          models,
          connected: available.map((p) => p.id),
        })
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
