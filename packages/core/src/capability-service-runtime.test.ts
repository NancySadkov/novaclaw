import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { CapabilityServiceRegistry } from "./capability-service-registry"
import { CapabilityServiceRuntime } from "./capability-service-runtime"
import { CapabilityServiceWorker } from "./capability-service-worker"
import { ConfigCapabilityService } from "./config/capability-service"
import { ResourcePressureContext } from "./resource-pressure-context"
import { SettingsConfigStore } from "./settings-config-store"

const declaration = (inputBytes?: number, healthIntervalMs?: number) =>
  new ConfigCapabilityService.Info({
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
    ...(inputBytes === undefined ? {} : { limits: new ConfigCapabilityService.Limits({ input_bytes: inputBytes }) }),
    ...(healthIntervalMs === undefined
      ? {}
      : {
          health: new ConfigCapabilityService.Health({
            interval_ms: healthIntervalMs,
            timeout_ms: 50,
          }),
        }),
  })

const graph = (input: {
  readonly info?: ConfigCapabilityService.Info
  readonly services?:
    | Readonly<Record<string, ConfigCapabilityService.Info>>
    | (() => Readonly<Record<string, ConfigCapabilityService.Info>>)
  readonly onSettingsRead?: () => void
  readonly capacity: () => ResourcePressureContext.CommitCapacity | undefined
  readonly worker: CapabilityServiceWorker.Interface
}) => {
  const settings = Layer.succeed(
    SettingsConfigStore.Service,
    SettingsConfigStore.Service.of({
      all: () =>
        Effect.sync(() => {
          input.onSettingsRead?.()
          const configured = typeof input.services === "function" ? input.services() : input.services
          return { capability_services: configured ?? { parser: input.info ?? declaration() } }
        }),
      serverPassword: () => Effect.succeed(undefined),
      set: () => Effect.void,
      update: () => Effect.void,
      remove: () => Effect.void,
      unreadable: () => Effect.succeed([]),
      isEmpty: () => Effect.succeed(false),
    }),
  )
  const pressure = Layer.succeed(
    ResourcePressureContext.Service,
    ResourcePressureContext.Service.of({
      inspect: () => Effect.succeed([]),
      capacity: () => Effect.sync(input.capacity),
      level: () => Effect.succeed("ok"),
    }),
  )
  return CapabilityServiceRuntime.layer.pipe(
    Layer.provide(CapabilityServiceRegistry.layer.pipe(Layer.provide(settings))),
    Layer.provide(pressure),
    Layer.provide(Layer.succeed(CapabilityServiceWorker.Service, CapabilityServiceWorker.Service.of(input.worker))),
  )
}

const waitUntil = (predicate: () => boolean, attempts = 100): Effect.Effect<void, Error> =>
  Effect.suspend(() =>
    predicate()
      ? Effect.void
      : attempts <= 0
        ? Effect.fail(new Error("condition did not become true"))
        : Effect.sleep(10).pipe(Effect.andThen(waitUntil(predicate, attempts - 1))),
  )

const waitForQueued = (
  runtime: CapabilityServiceRuntime.Interface,
  requestID: string,
  attempts = 100,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const queued = (yield* runtime.snapshot()).some((state) => state.queuedRequestIDs.includes(requestID))
    if (queued) return
    if (attempts <= 0) return yield* Effect.fail(new Error(`request ${requestID} was not queued`))
    yield* Effect.sleep(10)
    return yield* waitForQueued(runtime, requestID, attempts - 1)
  })

const waitForPhase = (
  runtime: CapabilityServiceRuntime.Interface,
  phase: string,
  attempts = 100,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if ((yield* runtime.snapshot()).some((state) => state.phase === phase)) return
    if (attempts <= 0) return yield* Effect.fail(new Error(`service did not become ${phase}`))
    yield* Effect.sleep(10)
    return yield* waitForPhase(runtime, phase, attempts - 1)
  })

describe("CapabilityServiceRuntime", () => {
  test("retains an immutable queued payload and dispatches it after live pressure recovery", async () => {
    let capacity: ResourcePressureContext.CommitCapacity = {
      limitBytes: 1_000,
      usedBytes: 700,
      floorUsedFraction: 0.8,
    }
    const calls: Array<Readonly<Record<string, unknown>>> = []
    const timing: string[] = []
    const input = { handle: "file:1" }
    const layer = graph({
      capacity: () => capacity,
      worker: {
        start: () => Effect.void,
        run: (request) => Effect.sync(() => (calls.push(request.arguments), { content: request.arguments })),
        stop: () => Effect.void,
        health: () => Effect.succeed(true),
      },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        const fiber = yield* Effect.forkScoped(
          runtime.execute({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: input,
            timing: {
              begin: (phase) =>
                Effect.sync(() => {
                  timing.push(`start:${phase}`)
                  return () => Effect.sync(() => timing.push(`end:${phase}`)).pipe(Effect.asVoid)
                }),
            },
          }),
        )
        yield* waitForQueued(runtime, "r1")
        expect((yield* runtime.snapshot())[0]?.queuedRequestIDs).toEqual(["r1"])
        input.handle = "mutated-after-enqueue"
        capacity = { limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(result).toEqual({ content: { handle: "file:1" } })
    expect(calls).toEqual([{ handle: "file:1" }])
    expect(timing).toEqual([
      "start:capability-queue",
      "end:capability-queue",
      "start:capability-load",
      "end:capability-load",
      "start:capability-run",
      "end:capability-run",
    ])
  })

  test("reloads a live worker from the current declaration before the next request", async () => {
    const at = (url: string) =>
      new ConfigCapabilityService.Info({
        capabilities: ["document.parse.native"],
        transport: new ConfigCapabilityService.HttpTransport({ type: "streamable-http", url }),
        locality: "local",
        resources: new ConfigCapabilityService.Resources({
          estimated_resident_bytes: 100,
          estimated_peak_bytes: 200,
        }),
      })
    let current = at("http://127.0.0.1:9010/mcp")
    const starts: string[] = []
    const layer = graph({
      services: () => ({ parser: current }),
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: (_serviceID, info) =>
          Effect.sync(() => starts.push(info.transport.type === "streamable-http" ? info.transport.url : "stdio")).pipe(
            Effect.asVoid,
          ),
        run: ({ arguments: input }) => Effect.succeed(input),
        stop: () => Effect.void,
        health: () => Effect.succeed(true),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        expect(
          yield* runtime.execute({
            serviceID: "parser",
            requestID: "before-repair",
            capability: "document.parse.native",
            arguments: { generation: 1 },
          }),
        ).toEqual({ generation: 1 })
        current = at("http://127.0.0.1:9020/mcp")
        expect(
          yield* runtime.execute({
            serviceID: "parser",
            requestID: "after-repair",
            capability: "document.parse.native",
            arguments: { generation: 2 },
          }),
        ).toEqual({ generation: 2 })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(starts).toEqual(["http://127.0.0.1:9010/mcp", "http://127.0.0.1:9020/mcp"])
  })

  test("a changed declaration re-arms an unavailable service without a process restart", async () => {
    const at = (url: string) =>
      new ConfigCapabilityService.Info({
        capabilities: ["document.parse.native"],
        transport: new ConfigCapabilityService.HttpTransport({ type: "streamable-http", url }),
        locality: "local",
        resources: new ConfigCapabilityService.Resources({
          estimated_resident_bytes: 100,
          estimated_peak_bytes: 200,
        }),
      })
    let current = at("http://127.0.0.1:9010/mcp")
    const layer = graph({
      services: () => ({ parser: current }),
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: (_serviceID, info) =>
          info.transport.type === "streamable-http" && info.transport.url.includes(":9010/")
            ? Effect.fail(new Error("old endpoint is down"))
            : Effect.void,
        run: () => Effect.succeed("repaired"),
        stop: () => Effect.void,
        health: () => Effect.succeed(true),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        expect(
          (yield* Effect.exit(
            runtime.execute({
              serviceID: "parser",
              requestID: "broken",
              capability: "document.parse.native",
              arguments: {},
            }),
          ))._tag,
        ).toBe("Failure")
        expect((yield* runtime.snapshot())[0]?.phase).toBe("unavailable")

        current = at("http://127.0.0.1:9020/mcp")
        expect(
          yield* runtime.execute({
            serviceID: "parser",
            requestID: "repaired",
            capability: "document.parse.native",
            arguments: {},
          }),
        ).toBe("repaired")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })

  test("serializes queued calls and dispatches the successor after completion", async () => {
    const firstGate = Deferred.makeUnsafe<void>()
    const calls: number[] = []
    const layer = graph({
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: () => Effect.void,
        run: (request) => {
          const sequence = request.arguments.sequence as number
          calls.push(sequence)
          return sequence === 1 ? Deferred.await(firstGate).pipe(Effect.as(sequence)) : Effect.succeed(sequence)
        },
        stop: () => Effect.void,
        health: () => Effect.succeed(true),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        const first = yield* Effect.forkScoped(
          runtime.execute({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: { sequence: 1 },
          }),
        )
        yield* waitUntil(() => calls.length === 1)
        const second = yield* Effect.forkScoped(
          runtime.execute({
            serviceID: "parser",
            requestID: "r2",
            capability: "document.parse.native",
            arguments: { sequence: 2 },
          }),
        )
        yield* Effect.sleep(25)
        expect(calls).toEqual([1])
        yield* Deferred.succeed(firstGate, undefined)
        expect(yield* Fiber.join(first)).toBe(1)
        expect(yield* Fiber.join(second)).toBe(2)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(calls).toEqual([1, 2])
  })

  test("unloads an idle victim and dispatches the retained target payload", async () => {
    let usedBytes = 100
    const calls: string[] = []
    const layer = graph({
      services: { idle: declaration(), target: declaration() },
      capacity: () => ({ limitBytes: 1_000, usedBytes, floorUsedFraction: 0.8 }),
      worker: {
        start: (serviceID) => Effect.sync(() => calls.push(`start:${serviceID}`)).pipe(Effect.asVoid),
        run: (request) => Effect.sync(() => (calls.push(`run:${request.serviceID}`), { service: request.serviceID })),
        stop: (serviceID) =>
          Effect.sync(() => {
            calls.push(`stop:${serviceID}`)
            usedBytes -= 100
          }),
        health: () => Effect.succeed(true),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        expect(
          yield* runtime.execute({
            serviceID: "idle",
            requestID: "warm",
            capability: "document.parse.native",
            arguments: {},
          }),
        ).toEqual({ service: "idle" })
        usedBytes = 700
        expect(
          yield* runtime.execute({
            serviceID: "target",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: { handle: "file:1" },
          }),
        ).toEqual({ service: "target" })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(calls).toEqual(["start:idle", "run:idle", "stop:idle", "start:target", "run:target"])
  })

  test("cancellation settles the waiter and reclaims an active worker", async () => {
    const runGate = Deferred.makeUnsafe<void>()
    const calls: string[] = []
    const layer = graph({
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: () => Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
        run: () => Deferred.await(runGate),
        stop: () => Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
        health: () => Effect.succeed(true),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        const fiber = yield* Effect.forkScoped(
          runtime.execute({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: {},
          }),
        )
        yield* waitUntil(() => calls.includes("start"))
        expect(yield* runtime.cancel("parser", "r1")).toBe(true)
        expect((yield* Effect.exit(Fiber.join(fiber)))._tag).toBe("Failure")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(calls).toEqual(["start", "stop"])
  })

  test("a worker crash fails the active request and every queued waiter", async () => {
    const crashGate = Deferred.makeUnsafe<void>()
    const calls: string[] = []
    const layer = graph({
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: () => Effect.void,
        run: () =>
          Effect.sync(() => calls.push("run")).pipe(
            Effect.andThen(Deferred.await(crashGate)),
            Effect.andThen(Effect.fail(new Error("worker crashed"))),
          ),
        stop: () => Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
        health: () => Effect.succeed(true),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        const first = yield* Effect.forkScoped(
          runtime.execute({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: {},
          }),
        )
        yield* waitUntil(() => calls.includes("run"))
        const second = yield* Effect.forkScoped(
          runtime.execute({
            serviceID: "parser",
            requestID: "r2",
            capability: "document.parse.native",
            arguments: {},
          }),
        )
        yield* waitForQueued(runtime, "r2")
        yield* Deferred.succeed(crashGate, undefined)
        expect((yield* Effect.exit(Fiber.join(first)))._tag).toBe("Failure")
        expect((yield* Effect.exit(Fiber.join(second)))._tag).toBe("Failure")
        expect((yield* runtime.snapshot())[0]?.phase).toBe("unavailable")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(calls).toEqual(["run", "stop"])
  })

  test("periodic health degrades an idle failed service without touching the completed chat", async () => {
    const calls: string[] = []
    const layer = graph({
      info: declaration(undefined, 1),
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: () => Effect.void,
        run: () => Effect.succeed({ content: "done" }),
        stop: () => Effect.sync(() => calls.push("stop")).pipe(Effect.asVoid),
        health: () => Effect.sync(() => (calls.push("health"), false)),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        expect(
          yield* runtime.execute({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: {},
          }),
        ).toEqual({ content: "done" })
        yield* waitForPhase(runtime, "unavailable")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(calls).toEqual(["health", "stop"])
  })

  test("periodic health waits until active inference returns idle", async () => {
    const runGate = Deferred.makeUnsafe<void>()
    const calls: string[] = []
    const layer = graph({
      info: declaration(undefined, 1),
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: () => Effect.void,
        run: () =>
          Effect.sync(() => calls.push("run")).pipe(Effect.andThen(Deferred.await(runGate)), Effect.as("done")),
        stop: () => Effect.void,
        health: () => Effect.sync(() => (calls.push("health"), true)),
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        const execution = yield* Effect.forkScoped(
          runtime.execute({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: {},
          }),
        )
        yield* waitUntil(() => calls.includes("run"))
        yield* Effect.sleep(300)
        expect(calls).toEqual(["run"])
        yield* Deferred.succeed(runGate, undefined)
        expect(yield* Fiber.join(execution)).toBe("done")
        yield* waitUntil(() => calls.includes("health"))
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(calls).toEqual(["run", "health"])
  })

  test("an idle healthy service does not reread the settings store on every pump tick", async () => {
    let reads = 0
    const layer = graph({
      info: declaration(undefined, 10_000),
      onSettingsRead: () => reads++,
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: () => Effect.void,
        run: () => Effect.succeed("done"),
        stop: () => Effect.void,
        health: () => Effect.succeed(true),
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        yield* runtime.execute({
          serviceID: "parser",
          requestID: "r1",
          capability: "document.parse.native",
          arguments: {},
        })
        const afterExecution = reads
        yield* Effect.sleep(300)
        expect(reads).toBe(afterExecution)
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })

  test("rejects an oversized payload before it reaches admission or a worker", async () => {
    const calls: string[] = []
    const layer = graph({
      info: declaration(10),
      capacity: () => ({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      worker: {
        start: () => Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
        run: () => Effect.succeed(undefined),
        stop: () => Effect.void,
        health: () => Effect.succeed(true),
      },
    })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        return yield* Effect.flip(
          runtime.execute({
            serviceID: "parser",
            requestID: "r1",
            capability: "document.parse.native",
            arguments: { content: "this is too large" },
          }),
        )
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(error.message).toContain("input limit is 10")
    expect(calls).toEqual([])
  })
})
