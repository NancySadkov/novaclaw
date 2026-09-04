import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { PluginV2 } from "@novaclaw/core/plugin"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

/**
 * ⚠️ **The plugin host is LOCATION-scoped, which is why this resolves one per request rather than
 * taking a service at layer scope.** Plugins are loaded per location — the built-ins plus whatever
 * that instance's config dir contributes — so "the loaded plugins" is only a well-formed question
 * once you name a directory. Taking `PluginV2.Service` at the top would have compiled against
 * whichever host happened to be in the layer and answered for the wrong one.
 */
export const pluginHandlers = HttpApiBuilder.group(InstanceHttpApi, "plugin", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    return handlers.handle(
      "list",
      Effect.fn("PluginHttpApi.list")(function* (ctx) {
        // ⚠️ `InstanceState.context` is NOT available here and reaching for it cost a 500 that every
        // one of the four layers typechecked past: that accessor needs an `InstanceRef` this route's
        // middleware does not provide. `ctx.query.directory ?? process.cwd()` is what the other
        // handlers on this middleware use, and it is the reason this endpoint was exercised against
        // the real mounted API rather than trusted because it compiled.
        const directory = ctx.query.directory ?? process.cwd()
        // Read straight from the live service. A snapshot cached anywhere else could name a plugin
        // that has since been removed, and a disclosure surface that is confidently out of date is
        // worse than one that is missing.
        return yield* Effect.gen(function* () {
          const plugin = yield* PluginV2.Service
          return yield* plugin.list
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
      }),
    )
  }),
)
