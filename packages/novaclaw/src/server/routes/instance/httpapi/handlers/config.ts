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
import { markInstanceForDisposal } from "../lifecycle"

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
    // anymore). Invalidate refreshes the service's cached store view; disposal makes location
    // boots re-snapshot.
    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      const consumed = yield* ConfigStoreWrite.apply(ctx.payload)
      if (consumed.size > 0) yield* configSvc.invalidate()
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
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
