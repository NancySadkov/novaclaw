import { Catalog } from "@novaclaw/core/catalog"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProviderNotFoundError } from "@novaclaw/protocol/errors"
import { response } from "../location"

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.provider.available())
        }),
      )
      .handle(
        "provider.remove",
        Effect.fn(function* (ctx) {
          // T10(iv): the true config-key delete — the store row goes away (instance-wide),
          // unlike the client-side disable-list hide. The live per-location catalog snapshot
          // still holds the provider until the next boot; the store is the durable truth.
          const store = yield* CatalogStore.Service
          yield* store.removeProvider(ctx.params.providerID)
          const fallback = yield* store.getDefault()
          if (fallback !== undefined && fallback.startsWith(ctx.params.providerID + "/")) yield* store.clearDefault()
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          const catalog = yield* Catalog.Service
          const provider = yield* catalog.provider.get(ctx.params.providerID)
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(provider))
        }),
      )
  }),
)
