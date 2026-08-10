export * as CapabilityServiceRegistry from "./capability-service-registry"

import { Context, Effect, Layer } from "effect"
import { Config } from "./config"
import type { ConfigCapabilityService } from "./config/capability-service"
import { makeLocationNode } from "./effect/app-node"

export interface Entry {
  readonly id: string
  readonly info: ConfigCapabilityService.Info
}

export interface Interface {
  /** All declarations, including disabled ones, for Settings/health inspection. */
  readonly inspect: () => Effect.Effect<ReadonlyArray<Entry>>
  /** Enabled services advertising one exact capability, in deterministic id order. */
  readonly candidates: (capability: string) => Effect.Effect<ReadonlyArray<Entry>>
  readonly get: (id: string) => Effect.Effect<Entry | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CapabilityServiceRegistry") {}

/** Live read-through view of the runtime-editable capability_services config key. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    let signature: string | undefined
    let entries: ReadonlyArray<Entry> = []
    const refresh = Effect.fnUntraced(function* () {
      const configured = Config.latest(yield* config.entries(), "capability_services")
      const next = configured === undefined ? "" : JSON.stringify(configured)
      if (next === signature) return
      signature = next
      entries = Object.keys(configured ?? {})
        .sort()
        .map((id) => ({ id, info: configured![id]! }))
    })
    const inspect = Effect.fn("CapabilityServiceRegistry.inspect")(function* () {
      yield* refresh()
      return entries
    })
    return Service.of({
      inspect,
      candidates: Effect.fn("CapabilityServiceRegistry.candidates")(function* (capability) {
        return (yield* inspect()).filter(
          (entry) => entry.info.disabled !== true && entry.info.capabilities.includes(capability),
        )
      }),
      get: Effect.fn("CapabilityServiceRegistry.get")(function* (id) {
        return (yield* inspect()).find((entry) => entry.id === id)
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
