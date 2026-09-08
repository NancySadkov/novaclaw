import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HealthApi, handlerLayer } from "../handler-api"

export const HealthHandler = handlerLayer(
  HttpApiBuilder.group(HealthApi, "server.health", (handlers) =>
    handlers.handle("health.get", () => Effect.succeed({ healthy: true as const })),
  ),
)
