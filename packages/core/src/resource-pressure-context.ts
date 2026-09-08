export * as ResourcePressureContext from "./resource-pressure-context"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"

/**
 * Dependency-inversion seam for host resource headroom.
 *
 * The probe belongs to the novaclaw Storage subsystem, while admission, the resource-status tool and
 * Nudge dispatch belong to core. This interface lets those consumers share Storage's one authoritative
 * measurement without making core depend on the outer package.
 */
export interface Interface {
  /** Full live detail for the on-demand resource_status tool, including a healthy answer. */
  readonly inspect: () => Effect.Effect<ReadonlyArray<string>>
  /** Structured Windows-commit/host-memory capacity for mechanical admission. Unknown is explicit. */
  readonly capacity: () => Effect.Effect<CommitCapacity | undefined>
  /** Worst live pressure level for hook dispatch. Unknown never masquerades as healthy. */
  readonly level: () => Effect.Effect<"ok" | "warning" | "floor" | "unknown">
}

export interface CommitCapacity {
  readonly limitBytes: number
  readonly usedBytes: number
  readonly floorUsedFraction: number
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ResourcePressureContext") {}

export const unavailable = ["Resource headroom is unavailable in this runtime."] as const

export const layer = Layer.succeed(
  Service,
  Service.of({
    inspect: () => Effect.succeed(unavailable),
    capacity: () => Effect.succeed(undefined),
    level: () => Effect.succeed("unknown"),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
