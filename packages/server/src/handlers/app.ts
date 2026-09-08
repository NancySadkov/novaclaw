import { AppEvent } from "@novaclaw/schema/app-event"
import { AppRegistry } from "@novaclaw/core/app-registry"
import { EventV2 } from "@novaclaw/core/event"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AppApi, handlerLayer } from "../handler-api"

// Removing a contributed home-app tile. See `protocol/groups/app.ts` for why only REMOVE lives on
// the /api/* contract while list/register are still the legacy `/app` routes.
//
// Idempotent on purpose: deleting an id that is not there answers 204 like deleting one that was.
// A launcher tile can be removed from two windows at once, and the second person should see the
// outcome they asked for, not an error about a race they did not cause.

export const AppHandler = handlerLayer(
  HttpApiBuilder.group(AppApi, "server.app", (handlers) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      return handlers.handle(
        "app.remove",
        Effect.fn(function* (ctx) {
          const removed = yield* Effect.promise(() => AppRegistry.removeApp(ctx.params.id))
          // The same event `register` publishes, so every OTHER open client refetches its manifest
          // list and the tile disappears there too — not only in the window that deleted it.
          if (removed)
            yield* events.publish(AppEvent.Registered, { id: ctx.params.id, title: "" }).pipe(Effect.ignore)
        }),
      )
    }),
  ),
)
