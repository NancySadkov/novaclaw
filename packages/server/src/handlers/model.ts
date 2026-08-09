import { Catalog } from "@novaclaw/core/catalog"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ModelApi, handlerLayer } from "../handler-api"
import { response } from "../location"

export const ModelHandler = handlerLayer(
  HttpApiBuilder.group(ModelApi, "server.model", (handlers) =>
    Effect.gen(function* () {
      return handlers.handle(
        "model.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.available())
        }),
      )
    }),
  ),
)
