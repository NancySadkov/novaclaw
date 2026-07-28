import { Reference } from "@novaclaw/core/reference"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ReferenceHandler = HttpApiBuilder.group(Api, "server.reference", (handlers) =>
  handlers
    .handle("reference.list", () => response(Reference.Service.use((reference) => reference.list())))
    .handle(
      "reference.remove",
      Effect.fn(function* (ctx) {
        // Deletes the config-store row (instance-wide). No default points at a reference alias, so
        // there is no dangling ref to prune here (unlike `agent.remove`).
        const store = yield* ReferenceConfigStore.Service
        yield* store.removeReference(ctx.params.name)
      }),
    ),
)
