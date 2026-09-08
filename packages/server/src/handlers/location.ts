import { Location } from "@novaclaw/core/location"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { LocationApi, handlerLayer } from "../handler-api"

export const LocationHandler = handlerLayer(
  HttpApiBuilder.group(LocationApi, "server.location", (handlers) =>
    handlers.handle(
      "location.get",
      Effect.fn(function* () {
        const location = yield* Location.Service
        return new Location.Info({
          directory: location.directory,
          workspaceID: location.workspaceID,
          root: location.root,
          origin: location.origin,
        })
      }),
    ),
  ),
)
