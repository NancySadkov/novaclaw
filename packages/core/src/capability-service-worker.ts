export * as CapabilityServiceWorker from "./capability-service-worker"

import { Context, Effect, Layer } from "effect"
import type { ConfigCapabilityService } from "./config/capability-service"
import { makeGlobalNode } from "./effect/app-node"

export interface RunInput {
  readonly serviceID: string
  readonly capability: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface Interface {
  readonly start: (serviceID: string, info: ConfigCapabilityService.Info) => Effect.Effect<void, Error>
  readonly run: (input: RunInput) => Effect.Effect<unknown, Error>
  readonly stop: (serviceID: string) => Effect.Effect<void, Error>
  readonly health: (serviceID: string, timeoutMs?: number) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CapabilityServiceWorker") {}

const unavailable = (operation: string) => new Error(`Capability service worker cannot ${operation} in this host`)

/** Fail-closed embedding fallback. The NovaClaw server replaces this node with its MCP worker. */
export const layer = Layer.succeed(
  Service,
  Service.of({
    start: () => Effect.fail(unavailable("start")),
    run: () => Effect.fail(unavailable("run")),
    stop: () => Effect.void,
    health: () => Effect.succeed(false),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
