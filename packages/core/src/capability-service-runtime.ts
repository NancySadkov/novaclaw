export * as CapabilityServiceRuntime from "./capability-service-runtime"

import { Context, Effect, Layer } from "effect"
import { CapabilityServiceGovernor } from "./capability-service-governor"
import { CapabilityServiceRegistry } from "./capability-service-registry"
import type { ConfigCapabilityService } from "./config/capability-service"
import { makeGlobalNode } from "./effect/app-node"
import { ResourcePressureContext } from "./resource-pressure-context"

type RequestInput = { readonly serviceID: string; readonly requestID: string; readonly nowMs: number }
type PollInput = { readonly serviceID: string; readonly nowMs: number }

export interface Interface {
  readonly request: (input: RequestInput) => Effect.Effect<CapabilityServiceGovernor.RequestDecision>
  readonly poll: (
    input: PollInput,
  ) => Effect.Effect<CapabilityServiceGovernor.RequestDecision | { readonly kind: "idle" }>
  readonly loaded: (serviceID: string) => Effect.Effect<CapabilityServiceGovernor.Transition>
  readonly completed: (serviceID: string, nowMs: number) => Effect.Effect<CapabilityServiceGovernor.Transition>
  readonly cancel: (serviceID: string, requestID: string) => Effect.Effect<CapabilityServiceGovernor.Transition>
  readonly failed: (serviceID: string, reason: string) => Effect.Effect<ReadonlyArray<string>>
  readonly retry: (serviceID: string) => Effect.Effect<boolean>
  readonly stopped: (serviceID: string) => Effect.Effect<void>
  readonly sweep: (nowMs: number) => Effect.Effect<ReadonlyArray<string>>
  readonly snapshot: () => Effect.Effect<ReadonlyArray<CapabilityServiceGovernor.Snapshot>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CapabilityServiceRuntime") {}

/**
 * Process-global wiring of declarations + authoritative host headroom + the deterministic governor.
 * It still returns actions rather than launching workers: the MCP driver is the side-effect boundary
 * that will execute them and acknowledge loaded/stopped/failed.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* CapabilityServiceRegistry.Service
    const pressure = yield* ResourcePressureContext.Service
    const governor = CapabilityServiceGovernor.make()
    const services = Effect.fn("CapabilityServiceRuntime.services")(function* () {
      return Object.fromEntries((yield* registry.inspect()).map((entry) => [entry.id, entry.info])) as Readonly<
        Record<string, ConfigCapabilityService.Info>
      >
    })
    return Service.of({
      request: Effect.fn("CapabilityServiceRuntime.request")(function* (input) {
        const capacity = yield* pressure.capacity()
        return governor.request({
          ...input,
          services: yield* services(),
          ...(capacity === undefined ? {} : { capacity }),
        })
      }),
      poll: Effect.fn("CapabilityServiceRuntime.poll")(function* (input) {
        const capacity = yield* pressure.capacity()
        return governor.poll({
          ...input,
          services: yield* services(),
          ...(capacity === undefined ? {} : { capacity }),
        })
      }),
      loaded: (serviceID) => Effect.sync(() => governor.loaded(serviceID)),
      completed: (serviceID, nowMs) => Effect.sync(() => governor.completed(serviceID, nowMs)),
      cancel: (serviceID, requestID) => Effect.sync(() => governor.cancel(serviceID, requestID)),
      failed: (serviceID, reason) => Effect.sync(() => governor.failed(serviceID, reason)),
      retry: (serviceID) => Effect.sync(() => governor.retry(serviceID)),
      stopped: (serviceID) => Effect.sync(() => governor.stopped(serviceID)),
      sweep: Effect.fn("CapabilityServiceRuntime.sweep")(function* (nowMs) {
        return governor.sweep(yield* services(), nowMs)
      }),
      snapshot: () => Effect.sync(governor.snapshot),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [CapabilityServiceRegistry.node, ResourcePressureContext.node],
})
