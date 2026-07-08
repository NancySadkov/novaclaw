import { Config } from "@/config/config"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ProviderCatalogView } from "@/provider/catalog-view"
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
      return Schema.decodeUnknownSync(ConfigV2.Info)(yield* configSvc.get())
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    // F1-final: connected providers now come from the V2 `Catalog` (available =
    // has credentials/integration), projected onto the V1 wire shape. Catalog is
    // location-scoped — resolve it through the shared location-service map.
    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const directory = (yield* InstanceState.context).directory
      return yield* Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const available = yield* catalog.provider.available()
        const models = yield* catalog.model.all()
        return ProviderCatalogView.configProvidersResult({ providers: available, models })
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
