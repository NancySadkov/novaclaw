import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ConfigApi, handlerLayer } from "../handler-api"

/** `InvalidRequestError.kind` for a removal that named nothing, so a client can branch on it
 *  without parsing prose — the convention `rejectUnknownConfigKeys` set for the PATCH route. */
export const CONFIG_REMOVE_REFUSED_KIND = "config-remove-refused"

export const ConfigHandler = handlerLayer(
  HttpApiBuilder.group(ConfigApi, "server.config", (handlers) =>
    handlers.handle(
      "config.remove",
      Effect.fn(function* (ctx) {
        // The decision, the transaction and the post-commit reload all live in
        // `ConfigStoreWrite.remove` — deliberately, because this is not the only caller that will
        // want them (the `configure` tool writes in-process and never touches HTTP), and an
        // invariant duplicated across call sites is one a new caller can forget.
        const report = yield* ConfigStoreWrite.remove(ctx.payload.paths).pipe(
          // A path that named nothing is CALLER input, so it is a 400 that names every offender —
          // not a 500, which would blame us for their typo. Same split the config PATCH route draws
          // between `rejectUnknownConfigKeys` (400) and `unroutedKeys` (a die inside the
          // transaction). Nothing was removed: `remove` is all-or-nothing and has rolled back.
          Effect.catchTag(
            "ConfigStoreWrite.ConfigRemoveRefused",
            (error) =>
              new InvalidRequestError({
                kind: CONFIG_REMOVE_REFUSED_KIND,
                message: error.message,
              }),
          ),
        )
        return { removed: report.removed.map((path) => [...path]), cleared: [...report.cleared] }
      }),
    ),
  ),
)
