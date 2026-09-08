import { Catalog } from "@novaclaw/core/catalog"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { ModelPrune } from "@novaclaw/core/catalog/model-prune"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Config } from "@novaclaw/core/config"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ProviderApi, handlerLayer } from "../handler-api"
import { ProviderNotFoundError } from "@novaclaw/protocol/errors"
import { response } from "../location"

export const ProviderHandler = handlerLayer(
  HttpApiBuilder.group(ProviderApi, "server.provider", (handlers) =>
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
          "provider.localModels",
          Effect.fn(function* () {
            const config = yield* Config.Service
            const manager = yield* LocalModelManager.Service
            return yield* manager.status(Config.latest(yield* config.entries(), "local_model_catalog"))
          }),
        )
        .handle(
          "provider.installLocalModel",
          Effect.fn(function* (ctx) {
            const config = yield* Config.Service
            const manager = yield* LocalModelManager.Service
            return yield* manager.install(
              ctx.params.profileID,
              ctx.payload.context,
              Config.latest(yield* config.entries(), "local_model_catalog"),
            )
          }),
        )
        .handle(
          "provider.stopLocalModel",
          Effect.fn(function* () {
            const manager = yield* LocalModelManager.Service
            return yield* manager.stop()
          }),
        )
        .handle(
          "provider.remove",
          Effect.fn(function* (ctx) {
            // T10(iv): the true config-key delete — the store row goes away (instance-wide),
            // unlike the client-side disable-list hide.
            const store = yield* CatalogStore.Service
            yield* store.removeProvider(ctx.params.providerID)
            const fallback = yield* store.getDefault()
            if (fallback !== undefined && fallback.startsWith(ctx.params.providerID + "/")) yield* store.clearDefault()
            // ⚠️ This line used to be absent, and this comment used to say "the live per-location
            // catalog snapshot still holds the provider until the next boot". It does not any more:
            // `apply` fires the same refresh for every `PATCH /config`, and a store write that
            // bypasses `apply` has to fire it too or the delete is durable-but-invisible.
            yield* ConfigStoreWrite.refreshDomain("catalog")
          }),
        )
        .handle(
          "provider.removeModel",
          Effect.fn(function* (ctx) {
            // The per-model twin of `provider.remove`. Before this existed the only ways to drop a
            // stale model were to delete its whole provider (taking every sibling with it) or to hide
            // it in a CLIENT-side preference that an agent, a second device and a headless instance
            // all still saw — a destructive dialog performing a local act while stating an
            // instance-wide fact (ruling 2).
            const store = yield* CatalogStore.Service
            const removed = yield* store.removeModel(ctx.params.providerID, ctx.query.modelID)
            // A no-op must NOT report success: without this the caller cannot tell "deleted" from
            // "was never here", which is the same failed-mutation-reports-success shape the wire's
            // unknown-key guard exists to close.
            if (!removed)
              return yield* new ProviderNotFoundError({
                providerID: ctx.params.providerID,
                message: `Model not found in provider "${ctx.params.providerID}": ${ctx.query.modelID}`,
              })
            const fallback = yield* store.getDefault()
            if (ModelPrune.refNamesModel(fallback, ctx.params.providerID, ctx.query.modelID))
              yield* store.clearDefault()
            // Fired AFTER the store writes commit — the reload re-reads the store, so firing it
            // earlier would re-materialise the pre-delete state and report success for it.
            yield* ConfigStoreWrite.refreshDomain("catalog")
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
  ),
)
