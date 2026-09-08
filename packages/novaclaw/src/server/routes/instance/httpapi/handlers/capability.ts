import { CapabilityRegistry } from "@novaclaw/core/effect/capability-registry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

export const capabilityHandlers = HttpApiBuilder.group(InstanceHttpApi, "capability", (handlers) =>
  Effect.gen(function* () {
    const registry = yield* CapabilityRegistry.Service

    return handlers
      .handle(
        "list",
        Effect.fn("CapabilityHttpApi.list")(function* () {
          return yield* registry.inspect()
        }),
      )
      .handle(
        "retry",
        Effect.fn("CapabilityHttpApi.retry")(function* (ctx) {
          const status = yield* registry
            .retry(ctx.params.name)
            .pipe(
              Effect.catchTag("CapabilityRegistry.NotFoundError", () =>
                Effect.fail(new InvalidRequestError({ message: `Unknown capability: ${ctx.params.name}` })),
              ),
            )
          return { name: ctx.params.name, status }
        }),
      )
  }),
)
