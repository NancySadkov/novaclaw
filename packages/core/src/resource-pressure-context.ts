export * as ResourcePressureContext from "./resource-pressure-context"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"

/**
 * Dependency-inversion seam for host resource headroom.
 *
 * The probe belongs to the novaclaw Storage subsystem, while the `<env>` block belongs to core.
 * Keeping this tiny line-oriented interface in core lets the server inject Storage's one authoritative
 * measurement without making core depend on the outer package. The fallback names the missing adapter
 * instead of silently pretending the host has room (ruling 2).
 */
export interface Interface {
  /** Exception-only ambient lines for the model's per-turn environment. Healthy/unknown is empty. */
  readonly lines: () => Effect.Effect<ReadonlyArray<string>>
  /** Full live detail for the on-demand resource_status tool, including a healthy answer. */
  readonly inspect: () => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ResourcePressureContext") {}

export const unavailable = ["Resource headroom is unavailable in this runtime."] as const

export const layer = Layer.succeed(
  Service,
  Service.of({ lines: () => Effect.succeed([]), inspect: () => Effect.succeed(unavailable) }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
