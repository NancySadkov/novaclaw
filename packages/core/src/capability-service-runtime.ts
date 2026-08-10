export * as CapabilityServiceRuntime from "./capability-service-runtime"

import { Context, Deferred, Effect, Layer } from "effect"
import { CapabilityServiceGovernor } from "./capability-service-governor"
import { CapabilityServiceRegistry } from "./capability-service-registry"
import { CapabilityServiceWorker } from "./capability-service-worker"
import type { ConfigCapabilityService } from "./config/capability-service"
import { makeGlobalNode } from "./effect/app-node"
import { ResourcePressureContext } from "./resource-pressure-context"
import { Log } from "@novaclaw/schema/log"
import type { SessionMessage } from "./session/message"

export const DEFAULT_INPUT_BYTES = 1024 * 1024
export const PRESSURE_POLL_MS = 250
export const DEFAULT_HEALTH_INTERVAL_MS = 30_000

export type Stage = Extract<SessionMessage.TurnPhase, "capability-queue" | "capability-load" | "capability-run">

export interface Timing {
  readonly begin: (phase: Stage) => Effect.Effect<() => Effect.Effect<void>>
}

export interface ExecuteInput extends CapabilityServiceWorker.RunInput {
  readonly requestID: string
  readonly timing?: Timing
}

interface Pending extends ExecuteInput {
  readonly deferred: Deferred.Deferred<unknown, Error>
  readonly closes: Map<Stage, () => Effect.Effect<void>>
  running: boolean
}

export interface Interface {
  /** Admit, queue if necessary, execute exactly once, and return the MCP observation. */
  readonly execute: (input: ExecuteInput) => Effect.Effect<unknown, Error>
  readonly cancel: (serviceID: string, requestID: string) => Effect.Effect<boolean>
  readonly failed: (serviceID: string, reason: string) => Effect.Effect<ReadonlyArray<string>>
  readonly retry: (serviceID: string) => Effect.Effect<boolean>
  readonly sweep: (nowMs: number) => Effect.Effect<ReadonlyArray<string>>
  readonly snapshot: () => Effect.Effect<ReadonlyArray<CapabilityServiceGovernor.Snapshot>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CapabilityServiceRuntime") {}

const keyOf = (serviceID: string, requestID: string) => `${serviceID}\u0000${requestID}`
const declarationKey = (info: ConfigCapabilityService.Info) => JSON.stringify(info)
const requestError = (serviceID: string, requestID: string, message: string) =>
  new Error(`Capability request "${requestID}" for service "${serviceID}" ${message}`)

/**
 * Process-global owner of immutable request payloads, authoritative host headroom, the deterministic
 * governor, and worker effects. A caller can execute only by waiting on this owner; no public method
 * can forge loaded/completed acknowledgements or bypass admission.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* CapabilityServiceRegistry.Service
    const pressure = yield* ResourcePressureContext.Service
    const worker = yield* CapabilityServiceWorker.Service
    const scope = yield* Effect.scope
    const governor = CapabilityServiceGovernor.make()
    const pending = new Map<string, Pending>()
    const nextHealthMs = new Map<string, number>()
    const healthInFlight = new Map<string, Deferred.Deferred<void>>()
    const loadedDeclarations = new Map<string, string>()
    const attemptedDeclarations = new Map<string, string>()

    const services = Effect.fn("CapabilityServiceRuntime.services")(function* () {
      return Object.fromEntries((yield* registry.inspect()).map((entry) => [entry.id, entry.info])) as Readonly<
        Record<string, ConfigCapabilityService.Info>
      >
    })

    const stageBegin = Effect.fn("CapabilityServiceRuntime.stageBegin")(function* (entry: Pending, stage: Stage) {
      if (entry.closes.has(stage) || entry.timing === undefined) return
      entry.closes.set(stage, yield* entry.timing.begin(stage))
    })
    const stageEnd = Effect.fn("CapabilityServiceRuntime.stageEnd")(function* (entry: Pending, stage: Stage) {
      const close = entry.closes.get(stage)
      if (close === undefined) return
      entry.closes.delete(stage)
      yield* close()
    })
    const stageEndAll = Effect.fn("CapabilityServiceRuntime.stageEndAll")(function* (entry: Pending) {
      for (const stage of [...entry.closes.keys()]) yield* stageEnd(entry, stage)
    })

    const settle = Effect.fn("CapabilityServiceRuntime.settle")(function* (
      ids: ReadonlyArray<string>,
      serviceID: string,
      error: Error,
    ) {
      for (const requestID of ids) {
        const key = keyOf(serviceID, requestID)
        const entry = pending.get(key)
        if (entry === undefined) continue
        pending.delete(key)
        yield* stageEndAll(entry)
        yield* Deferred.fail(entry.deferred, error)
      }
    })

    const failService = Effect.fn("CapabilityServiceRuntime.failService")(function* (
      serviceID: string,
      reason: string,
    ) {
      nextHealthMs.delete(serviceID)
      loadedDeclarations.delete(serviceID)
      yield* worker.stop(serviceID).pipe(Effect.ignore)
      const affected = governor.failed(serviceID, reason)
      yield* settle(affected, serviceID, new Error(reason))
      return affected
    })

    const stop = Effect.fn("CapabilityServiceRuntime.stopWorker")(function* (serviceID: string) {
      const health = healthInFlight.get(serviceID)
      if (health !== undefined) yield* Deferred.await(health)
      nextHealthMs.delete(serviceID)
      loadedDeclarations.delete(serviceID)
      yield* worker.stop(serviceID)
      governor.stopped(serviceID)
    })

    const prepare = Effect.fn("CapabilityServiceRuntime.prepare")(function* (
      serviceID: string,
      entry: Pending | undefined,
      nowMs: number,
      initial: CapabilityServiceGovernor.RequestDecision | { readonly kind: "idle" },
    ) {
      let decision = initial
      if (decision.kind === "queued" && decision.unload.length > 0) {
        for (const victim of decision.unload) {
          yield* stop(victim).pipe(
            Effect.catch((error) => failService(victim, error.message).pipe(Effect.asVoid)),
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
      if (entry !== undefined) yield* stageBegin(entry, "capability-load")
      attemptedDeclarations.set(serviceID, declarationKey(info))
      return yield* worker.start(serviceID, info).pipe(
        Effect.map(() => {
          loadedDeclarations.set(serviceID, declarationKey(info))
          nextHealthMs.set(serviceID, Date.now() + (info.health?.interval_ms ?? DEFAULT_HEALTH_INTERVAL_MS))
          const transition = governor.loaded(serviceID)
          return transition.kind === "run" ? transition : ({ kind: "idle" } as const)
        }),
        Effect.catch((error) =>
          failService(serviceID, error.message).pipe(
            Effect.as({ kind: "refused", reason: "unavailable" } as const),
          ),
        ),
        Effect.ensuring(entry === undefined ? Effect.void : stageEnd(entry, "capability-load")),
      )
    })

    const dispatch = Effect.fn("CapabilityServiceRuntime.dispatch")(function* (entry: Pending) {
      if (entry.running) return
      entry.running = true
      const key = keyOf(entry.serviceID, entry.requestID)
      const health = healthInFlight.get(entry.serviceID)
      if (health !== undefined) yield* Deferred.await(health)
      const admitted = governor
        .snapshot()
        .find((state) => state.serviceID === entry.serviceID && state.activeRequestID === entry.requestID)
      if (pending.get(key) !== entry || admitted?.phase !== "busy") return
      const info = (yield* services())[entry.serviceID]
      if (info === undefined || info.disabled === true) {
        yield* failService(entry.serviceID, "Capability service was disabled while its request was waiting")
        return
      }
      if (loadedDeclarations.get(entry.serviceID) !== declarationKey(info)) {
        yield* stageBegin(entry, "capability-load")
        attemptedDeclarations.set(entry.serviceID, declarationKey(info))
        const refreshed = yield* worker.start(entry.serviceID, info).pipe(
          Effect.map(() => {
            loadedDeclarations.set(entry.serviceID, declarationKey(info))
            nextHealthMs.set(
              entry.serviceID,
              Date.now() + (info.health?.interval_ms ?? DEFAULT_HEALTH_INTERVAL_MS),
            )
            return true
          }),
          Effect.catch((error) => failService(entry.serviceID, error.message).pipe(Effect.as(false))),
          Effect.ensuring(stageEnd(entry, "capability-load")),
        )
        if (!refreshed) return
      }
      yield* stageBegin(entry, "capability-run")
      yield* worker
        .run({ serviceID: entry.serviceID, capability: entry.capability, arguments: entry.arguments })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) => failService(entry.serviceID, error.message).pipe(Effect.asVoid),
            onSuccess: (result) =>
              Effect.gen(function* () {
                yield* stageEnd(entry, "capability-run")
                governor.completed(entry.serviceID, Date.now())
                pending.delete(key)
                yield* Deferred.succeed(entry.deferred, result)
              }),
          }),
          Effect.ensuring(stageEnd(entry, "capability-run")),
        )
    })

    const launch = Effect.fn("CapabilityServiceRuntime.launch")(function* (
      serviceID: string,
      requestID: string,
      decision: CapabilityServiceGovernor.RequestDecision | { readonly kind: "idle" },
    ) {
      if (decision.kind === "run") {
        const entry = pending.get(keyOf(serviceID, decision.requestID))
        if (entry !== undefined) {
          yield* stageEnd(entry, "capability-queue")
          yield* dispatch(entry).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
        }
        return
      }
      if (decision.kind !== "refused") return
      yield* settle(
        [requestID],
        serviceID,
        requestError(serviceID, requestID, `was refused (${decision.reason})`),
      )
    })

    const admit = Effect.fn("CapabilityServiceRuntime.admit")(function* (entry: Pending) {
      const capacity = yield* pressure.capacity()
      const decision = governor.request({
        serviceID: entry.serviceID,
        requestID: entry.requestID,
        nowMs: Date.now(),
        services: yield* services(),
        ...(capacity === undefined ? {} : { capacity }),
      })
      if (decision.kind === "queued") yield* stageBegin(entry, "capability-queue")
      if (decision.kind === "start") yield* stageEnd(entry, "capability-queue")
      yield* launch(
        entry.serviceID,
        entry.requestID,
        yield* prepare(entry.serviceID, entry, Date.now(), decision),
      )
    })

    const pump = Effect.fn("CapabilityServiceRuntime.pump")(function* () {
      const serviceMap = yield* services()
      for (const state of governor.snapshot()) {
        if (state.queuedRequestIDs.length === 0 || (state.phase !== "stopped" && state.phase !== "ready")) continue
        const requestID = state.queuedRequestIDs[0]!
        const entry = pending.get(keyOf(state.serviceID, requestID))
        if (entry === undefined) {
          governor.cancel(state.serviceID, requestID)
          continue
        }
        const capacity = yield* pressure.capacity()
        const decision = governor.poll({
          serviceID: state.serviceID,
          nowMs: Date.now(),
          services: serviceMap,
          ...(capacity === undefined ? {} : { capacity }),
        })
        if (decision.kind === "start") yield* stageEnd(entry, "capability-queue")
        yield* launch(state.serviceID, requestID, yield* prepare(state.serviceID, entry, Date.now(), decision))
      }
    })

    const scheduleHealth = Effect.fn("CapabilityServiceRuntime.scheduleHealth")(function* () {
      const nowMs = Date.now()
      const serviceMap = yield* services()
      for (const state of governor.snapshot()) {
        if (state.phase !== "ready" || healthInFlight.has(state.serviceID)) continue
        const info = serviceMap[state.serviceID]
        if (info === undefined) continue
        const due = nextHealthMs.get(state.serviceID)
        if (due === undefined) {
          nextHealthMs.set(state.serviceID, nowMs + (info.health?.interval_ms ?? DEFAULT_HEALTH_INTERVAL_MS))
          continue
        }
        if (nowMs < due) continue
        const done = Deferred.makeUnsafe<void>()
        healthInFlight.set(state.serviceID, done)
        const check = worker.health(state.serviceID, info.health?.timeout_ms).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Log.event("instance.capability.health.failed", {
                "instance.capability": state.serviceID,
                "instance.cause": Log.fault(error),
              }).pipe(
                Effect.andThen(failService(state.serviceID, `Health check failed: ${error.message}`)),
                Effect.asVoid,
              ),
            onSuccess: (healthy) =>
              healthy
                ? Effect.sync(() =>
                    nextHealthMs.set(
                      state.serviceID,
                      Date.now() + (info.health?.interval_ms ?? DEFAULT_HEALTH_INTERVAL_MS),
                    ),
                  ).pipe(Effect.asVoid)
                : Log.event("instance.capability.health.failed", {
                    "instance.capability": state.serviceID,
                    "instance.cause": Log.fault(new Error("MCP ping returned unhealthy")),
                  }).pipe(Effect.andThen(failService(state.serviceID, "Health check failed")), Effect.asVoid),
          }),
          Effect.ensuring(
            Effect.sync(() => healthInFlight.delete(state.serviceID)).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
              Effect.asVoid,
            ),
          ),
        )
        yield* check.pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
      }
    })

    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(PRESSURE_POLL_MS)
        if (pending.size > 0)
          yield* pump().pipe(
            Effect.catchCause((cause) =>
              Log.event("instance.capability.pump.failed", { "instance.cause": Log.fault(cause) }),
            ),
          )
        const healthDue = governor
          .snapshot()
          .some(
            (state) =>
              state.phase === "ready" &&
              !healthInFlight.has(state.serviceID) &&
              (nextHealthMs.get(state.serviceID) ?? Number.POSITIVE_INFINITY) <= Date.now(),
          )
        if (healthDue)
          yield* scheduleHealth().pipe(
            Effect.catchCause((cause) =>
              Log.event("instance.capability.pump.failed", { "instance.cause": Log.fault(cause) }),
            ),
          )
      }
    }).pipe(Effect.forkIn(scope, { startImmediately: true }))

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...pending.values()],
        (entry) => Deferred.fail(entry.deferred, requestError(entry.serviceID, entry.requestID, "was interrupted")),
        { discard: true },
      ).pipe(Effect.ignore),
    )

    const cancel = Effect.fn("CapabilityServiceRuntime.cancel")(function* (serviceID: string, requestID: string) {
      const key = keyOf(serviceID, requestID)
      const entry = pending.get(key)
      if (entry === undefined) return false
      pending.delete(key)
      yield* stageEndAll(entry)
      yield* Deferred.fail(entry.deferred, requestError(serviceID, requestID, "was canceled"))
      const transition = governor.cancel(serviceID, requestID)
      if (transition.kind === "stop")
        yield* stop(serviceID).pipe(
          Effect.catch((error) => failService(serviceID, error.message).pipe(Effect.asVoid)),
        )
      return true
    })

    return Service.of({
      execute: Effect.fn("CapabilityServiceRuntime.execute")(function* (input) {
        const existing = pending.get(keyOf(input.serviceID, input.requestID))
        if (existing !== undefined) return yield* Deferred.await(existing.deferred)
        const info = (yield* services())[input.serviceID]
        if (info === undefined || info.disabled === true)
          return yield* Effect.fail(requestError(input.serviceID, input.requestID, "is disabled"))
        const declaration = declarationKey(info)
        const attempted = attemptedDeclarations.get(input.serviceID)
        if (attempted !== undefined && attempted !== declaration) governor.retry(input.serviceID)
        const serialized = yield* Effect.try({
          try: () => JSON.stringify(input.arguments),
          catch: () => requestError(input.serviceID, input.requestID, "has non-serializable arguments"),
        })
        if (typeof serialized !== "string")
          return yield* Effect.fail(requestError(input.serviceID, input.requestID, "has non-serializable arguments"))
        const bytes = new TextEncoder().encode(serialized).byteLength
        const limit = info.limits?.input_bytes ?? DEFAULT_INPUT_BYTES
        if (bytes > limit)
          return yield* Effect.fail(
            requestError(input.serviceID, input.requestID, `is ${bytes} bytes; the input limit is ${limit}`),
          )
        const deferred = yield* Deferred.make<unknown, Error>()
        const entry: Pending = {
          ...input,
          arguments: JSON.parse(serialized) as Readonly<Record<string, unknown>>,
          deferred,
          closes: new Map(),
          running: false,
        }
        pending.set(keyOf(input.serviceID, input.requestID), entry)
        return yield* admit(entry).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.onInterrupt(() => cancel(input.serviceID, input.requestID).pipe(Effect.ignore)),
        )
      }),
      cancel,
      failed: failService,
      retry: (serviceID) => Effect.sync(() => governor.retry(serviceID)),
      sweep: Effect.fn("CapabilityServiceRuntime.sweep")(function* (nowMs) {
        const victims = governor.sweep(yield* services(), nowMs)
        for (const serviceID of victims)
          yield* stop(serviceID).pipe(
            Effect.catch((error) => failService(serviceID, error.message).pipe(Effect.asVoid)),
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
