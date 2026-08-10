export * as CapabilityServiceRuntime from "./capability-service-runtime"

import { Context, Effect, Layer } from "effect"
import { CapabilityServiceGovernor } from "./capability-service-governor"
import { CapabilityServiceRegistry } from "./capability-service-registry"
import { CapabilityServiceWorker } from "./capability-service-worker"
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
  readonly run: (
    input: CapabilityServiceWorker.RunInput & { readonly requestID: string; readonly nowMs: number },
  ) => Effect.Effect<unknown, Error>
  readonly cancel: (serviceID: string, requestID: string) => Effect.Effect<CapabilityServiceGovernor.Transition>
  readonly failed: (serviceID: string, reason: string) => Effect.Effect<ReadonlyArray<string>>
  readonly retry: (serviceID: string) => Effect.Effect<boolean>
  readonly sweep: (nowMs: number) => Effect.Effect<ReadonlyArray<string>>
  readonly snapshot: () => Effect.Effect<ReadonlyArray<CapabilityServiceGovernor.Snapshot>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CapabilityServiceRuntime") {}

/**
 * Process-global owner of declarations + authoritative host headroom + the deterministic governor.
 * Worker effects happen only after admission; their observed success/failure acknowledges the state.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* CapabilityServiceRegistry.Service
    const pressure = yield* ResourcePressureContext.Service
    const worker = yield* CapabilityServiceWorker.Service
    const governor = CapabilityServiceGovernor.make()
    const services = Effect.fn("CapabilityServiceRuntime.services")(function* () {
      return Object.fromEntries((yield* registry.inspect()).map((entry) => [entry.id, entry.info])) as Readonly<
        Record<string, ConfigCapabilityService.Info>
      >
    })
    const stop = Effect.fn("CapabilityServiceRuntime.stopWorker")(function* (serviceID: string) {
      yield* worker.stop(serviceID)
      governor.stopped(serviceID)
    })
    const prepare = Effect.fn("CapabilityServiceRuntime.prepare")(function* (
      serviceID: string,
      nowMs: number,
      decision: CapabilityServiceGovernor.RequestDecision | { readonly kind: "idle" },
    ) {
      if (decision.kind === "queued" && decision.unload.length > 0) {
        for (const victim of decision.unload) {
          yield* stop(victim).pipe(
            Effect.catch((error) => Effect.sync(() => governor.failed(victim, error.message))),
          )
        }
        const capacity = yield* pressure.capacity()
        decision = governor.poll({
          serviceID,
          nowMs,
          services: yield* services(),
          ...(capacity === undefined ? {} : { capacity }),
        })
      }
      if (decision.kind !== "start") return decision
      const info = (yield* services())[serviceID]
      if (info === undefined) return { kind: "refused", reason: "disabled" } as const
      return yield* worker.start(serviceID, info).pipe(
        Effect.map(() => {
          const transition = governor.loaded(serviceID)
          return transition.kind === "run" ? transition : ({ kind: "idle" } as const)
        }),
        Effect.catch((error) =>
          Effect.sync(() => {
            governor.failed(serviceID, error.message)
            return { kind: "refused", reason: "unavailable" } as const
          }),
        ),
      )
    })
    return Service.of({
      request: Effect.fn("CapabilityServiceRuntime.request")(function* (input) {
        const capacity = yield* pressure.capacity()
        const decision = governor.request({
          ...input,
          services: yield* services(),
          ...(capacity === undefined ? {} : { capacity }),
        })
        const prepared = yield* prepare(input.serviceID, input.nowMs, decision)
        return prepared.kind === "idle" ? ({ kind: "refused", reason: "unavailable" } as const) : prepared
      }),
      poll: Effect.fn("CapabilityServiceRuntime.poll")(function* (input) {
        const capacity = yield* pressure.capacity()
        const decision = governor.poll({
          ...input,
          services: yield* services(),
          ...(capacity === undefined ? {} : { capacity }),
        })
        return yield* prepare(input.serviceID, input.nowMs, decision)
      }),
      run: Effect.fn("CapabilityServiceRuntime.run")(function* (input) {
        const state = governor.snapshot().find((entry) => entry.serviceID === input.serviceID)
        if (state?.phase !== "busy" || state.activeRequestID !== input.requestID)
          return yield* Effect.fail(
            new Error(`Capability request "${input.requestID}" is not admitted for service "${input.serviceID}"`),
          )
        return yield* worker.run(input).pipe(
          Effect.tap(() => Effect.sync(() => governor.completed(input.serviceID, input.nowMs))),
          Effect.catch((error) =>
            worker.stop(input.serviceID).pipe(
              Effect.ignore,
              Effect.andThen(Effect.sync(() => governor.failed(input.serviceID, error.message))),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        )
      }),
      cancel: (serviceID, requestID) =>
        Effect.gen(function* () {
          const transition = governor.cancel(serviceID, requestID)
          if (transition.kind === "stop")
            yield* stop(serviceID).pipe(
              Effect.catch((error) => Effect.sync(() => governor.failed(serviceID, error.message))),
            )
          return transition.kind === "stop" ? ({ kind: "idle" } as const) : transition
        }),
      failed: (serviceID, reason) =>
        worker.stop(serviceID).pipe(
          Effect.ignore,
          Effect.andThen(Effect.sync(() => governor.failed(serviceID, reason))),
        ),
      retry: (serviceID) => Effect.sync(() => governor.retry(serviceID)),
      sweep: Effect.fn("CapabilityServiceRuntime.sweep")(function* (nowMs) {
        const victims = governor.sweep(yield* services(), nowMs)
        for (const serviceID of victims)
          yield* stop(serviceID).pipe(
            Effect.catch((error) => Effect.sync(() => governor.failed(serviceID, error.message))),
          )
        return victims
      }),
      snapshot: () => Effect.sync(governor.snapshot),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [CapabilityServiceRegistry.node, ResourcePressureContext.node, CapabilityServiceWorker.node],
})
