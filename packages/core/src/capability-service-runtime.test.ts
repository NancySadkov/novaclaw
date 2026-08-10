import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CapabilityServiceRegistry } from "./capability-service-registry"
import { CapabilityServiceRuntime } from "./capability-service-runtime"
import { CapabilityServiceWorker } from "./capability-service-worker"
import { ConfigCapabilityService } from "./config/capability-service"
import { ResourcePressureContext } from "./resource-pressure-context"
import { SettingsConfigStore } from "./settings-config-store"

const declaration = new ConfigCapabilityService.Info({
  capabilities: ["document.parse.native"],
  transport: new ConfigCapabilityService.HttpTransport({
    type: "streamable-http",
    url: "http://127.0.0.1:9010/mcp",
  }),
  locality: "local",
  resources: new ConfigCapabilityService.Resources({
    estimated_resident_bytes: 100,
    estimated_peak_bytes: 200,
  }),
})

const acceptingWorker = Layer.succeed(
  CapabilityServiceWorker.Service,
  CapabilityServiceWorker.Service.of({
    start: () => Effect.void,
    run: () => Effect.succeed(undefined),
    stop: () => Effect.void,
    health: () => Effect.succeed(true),
  }),
)

describe("CapabilityServiceRuntime", () => {
  test("re-admits queued work from the same live Storage capacity seam", async () => {
    let capacity: ResourcePressureContext.CommitCapacity | undefined = {
      limitBytes: 1_000,
      usedBytes: 700,
      floorUsedFraction: 0.8,
    }
    const settings = Layer.succeed(
      SettingsConfigStore.Service,
      SettingsConfigStore.Service.of({
        all: () => Effect.succeed({ capability_services: { parser: declaration } }),
        set: () => Effect.void,
        remove: () => Effect.void,
        isEmpty: () => Effect.succeed(false),
      }),
    )
    const pressure = Layer.succeed(
      ResourcePressureContext.Service,
      ResourcePressureContext.Service.of({
        lines: () => Effect.succeed([]),
        inspect: () => Effect.succeed([]),
        capacity: () => Effect.sync(() => capacity),
      }),
    )
    const layer = CapabilityServiceRuntime.layer.pipe(
      Layer.provide(CapabilityServiceRegistry.layer.pipe(Layer.provide(settings))),
      Layer.provide(pressure),
      Layer.provide(acceptingWorker),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        expect(yield* runtime.request({ serviceID: "parser", requestID: "r1", nowMs: 0 })).toEqual({
          kind: "queued",
          position: 1,
          unload: [],
        })
        capacity = { limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }
        expect(yield* runtime.poll({ serviceID: "parser", nowMs: 1 })).toEqual({ kind: "run", requestID: "r1" })
      }).pipe(Effect.provide(layer)),
    )
  })

  test("unknown capacity fails closed through the fallback adapter", async () => {
    const settings = Layer.succeed(
      SettingsConfigStore.Service,
      SettingsConfigStore.Service.of({
        all: () => Effect.succeed({ capability_services: { parser: declaration } }),
        set: () => Effect.void,
        remove: () => Effect.void,
        isEmpty: () => Effect.succeed(false),
      }),
    )
    const layer = CapabilityServiceRuntime.layer.pipe(
      Layer.provide(CapabilityServiceRegistry.layer.pipe(Layer.provide(settings))),
      Layer.provide(ResourcePressureContext.layer),
      Layer.provide(acceptingWorker),
    )
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        return yield* runtime.request({
          serviceID: "parser",
          requestID: "r1",
          nowMs: 0,
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(decision.kind).toBe("queued")
  })

  test("starts, runs, completes, and stops a governed worker", async () => {
    const calls: string[] = []
    const settings = Layer.succeed(
      SettingsConfigStore.Service,
      SettingsConfigStore.Service.of({
        all: () => Effect.succeed({ capability_services: { parser: declaration } }),
        set: () => Effect.void,
        remove: () => Effect.void,
        isEmpty: () => Effect.succeed(false),
      }),
    )
    const pressure = Layer.succeed(
      ResourcePressureContext.Service,
      ResourcePressureContext.Service.of({
        lines: () => Effect.succeed([]),
        inspect: () => Effect.succeed([]),
        capacity: () => Effect.succeed({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      }),
    )
    const worker = Layer.succeed(
      CapabilityServiceWorker.Service,
      CapabilityServiceWorker.Service.of({
        start: (id) => Effect.sync(() => calls.push(`start:${id}`)).pipe(Effect.asVoid),
        run: (input) => Effect.sync(() => (calls.push(`run:${input.capability}`), { ok: true })),
        stop: (id) => Effect.sync(() => calls.push(`stop:${id}`)).pipe(Effect.asVoid),
        health: () => Effect.succeed(true),
      }),
    )
    const layer = CapabilityServiceRuntime.layer.pipe(
      Layer.provide(CapabilityServiceRegistry.layer.pipe(Layer.provide(settings))),
      Layer.provide(pressure),
      Layer.provide(worker),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        expect(yield* runtime.request({ serviceID: "parser", requestID: "r1", nowMs: 0 })).toEqual({
          kind: "run",
          requestID: "r1",
        })
        expect(
          yield* runtime.run({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: { handle: "file:1" },
            nowMs: 10,
          }),
        ).toEqual({ ok: true })
        expect(
          yield* Effect.flip(
            runtime.run({
              serviceID: "parser",
              requestID: "r2",
              capability: "document.parse.native",
              arguments: {},
              nowMs: 11,
            }),
          ),
        ).toBeInstanceOf(Error)
        expect(yield* runtime.sweep(20)).toEqual([])
      }).pipe(Effect.provide(layer)),
    )
    expect(calls).toEqual(["start:parser", "run:document.parse.native"])
  })
})
