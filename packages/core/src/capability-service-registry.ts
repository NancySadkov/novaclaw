export * as CapabilityServiceRegistry from "./capability-service-registry"

import { Context, Effect, Layer, Schema } from "effect"
import { ConfigCapabilityService } from "./config/capability-service"
import { makeGlobalNode } from "./effect/app-node"
import { SettingsConfigStore } from "./settings-config-store"

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

const decode = Schema.decodeUnknownOption(Schema.Record(Schema.String, ConfigCapabilityService.Info))

/** Live, process-global read-through view of the runtime-editable capability_services store key. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* SettingsConfigStore.Service
    let signature: string | undefined
    let entries: ReadonlyArray<Entry> = []
    const refresh = Effect.fnUntraced(function* () {
      const decoded = decode((yield* settings.all()).capability_services)
      const configured = decoded._tag === "Some" ? decoded.value : undefined
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

export const node = makeGlobalNode({ service: Service, layer, deps: [SettingsConfigStore.node] })
