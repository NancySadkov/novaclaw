import { test, type TestOptions } from "bun:test"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import type { Config } from "@/config/config"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { InstanceStore } from "@/project/instance-store"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)
type InstanceOptions<E, R> = {
  git?: boolean
  config?: Partial<Config.Info> | (() => Partial<Config.Info>)
  init?: (directory: string) => Effect.Effect<void, E, R>
}

function isInstanceOptions<E, R>(
  options: InstanceOptions<E, R> | number | TestOptions | undefined,
): options is InstanceOptions<E, R> {
  return !!options && typeof options === "object" && ("git" in options || "config" in options || "init" in options)
}

function instanceArgs<E, R>(
  options?: InstanceOptions<E, R> | number | TestOptions,
  testOptions?: number | TestOptions,
): { instanceOptions: InstanceOptions<E, R> | undefined; testOptions: number | TestOptions | undefined } {
  if (typeof options === "number") return { instanceOptions: undefined, testOptions: options }
  if (isInstanceOptions(options)) return { instanceOptions: options, testOptions }
  return { instanceOptions: undefined, testOptions: options }
}

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

type Runner = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) => Promise<A>

const isolatedRun: Runner = (value, layer) =>
  Effect.gen(function* () {
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  }).pipe(Effect.runPromise)

// ─── the shared runner ──────────────────────────────────────────────────────────────────────────
//
// `isolatedRun` above gives every test a PRIVATE build of its whole layer graph. For a leaf service
// that is what you want. For `test/server/httpapi-layer.ts` it is not: that layer is
// `HttpRouter.serve(HttpApiApp.routes)`, i.e. `LayerNode.compile` over ~52 global nodes plus the
// messenger stack, `CalendarScheduler`, `Observability`, the catalog/recipe seeds and `Database`
// with its migration `apply()` — rebuilt per test, across the 12 files that compose it.
//
// Measured 2026-07-29 on `httpapi-workspace.test.ts` (9 tests), with the build/teardown of each test
// timed separately: isolated paid **3.0 s of layer build + 3.0 s of teardown**; shared pays
// **2.2 s of build (1.9 s of it the one-time pin) + 0.36 s of teardown**. Per test after the first
// that is ~164 ms → ~30 ms to build and ~337 ms → ~40 ms to tear down. In WALL CLOCK it is worth
// less than that sounds — an interleaved five-pair A/B on that file measured a median 17.7 s → 16.2 s
// against a box that swings ±30% — so take this for what it is: a real cost removed, not the lever
// that gets the gate under five minutes (todo/test-speed.md).
//
// ⚠️ **The memo map alone does NOT make a graph shared — an OBSERVER does.** Effect's `MemoMap`
// entries are REFERENCE COUNTED (`Layer.ts` → `memoMapBuild`/`memoMapReuse`): a build sets
// `observers = 1` and registers a finalizer on the CALLER's scope; every reuse increments; every
// scope close decrements, and at zero the entry is deleted from the map and its layer scope closed.
// So a `buildWithMemoMap(layer, memoMap, scope)` whose scope is then closed leaves the map exactly
// as it found it. The sharing that already exists in this package comes from two never-closed
// scopes: `HttpEffect.toWebHandlerLayerWith`'s (behind `Server.Default()`) and `fixture.ts`'s
// `onServer()`. `pinLayer` below is the third, and the one these suites needed.
//
// What is pinned is the APP layer only. The per-test `testEnv`/`liveEnv` (TestClock, TestConsole)
// are built through the same memo map but observed ONLY by the per-test scope, so they are
// constructed and finalized per test exactly as they are under `isolatedRun` — a shared TestClock
// across a file would be a real isolation defect, and it is avoided by construction rather than by
// a note asking the next person not to do it.

/** One never-closed build per app layer. Keyed on the layer object, which is what `MemoMap` keys on. */
const pinnedLayers = new Map<Layer.Layer<never, unknown>, Promise<unknown>>()

/**
 * Hold ONE process-lifetime observer on `layer` inside the shared `memoMap`.
 *
 * The scope is deliberately never closed — the same shape, and for the same reason, as
 * `fixture.ts`'s `onServer()`: releasing it would finalize the very `:memory:` database and HTTP
 * handler graph that `Server.Default()` and the sweep are memoizing against.
 */
const pinLayer = <R, E>(layer: Layer.Layer<R, E>): Promise<unknown> => {
  const key = layer as unknown as Layer.Layer<never, unknown>
  let built = pinnedLayers.get(key)
  if (built === undefined) {
    built = Effect.runPromise(Layer.buildWithMemoMap(layer, memoMap, Scope.makeUnsafe()))
    pinnedLayers.set(key, built)
  }
  return built
}

/**
 * Build the test layer through the shared process-wide `memoMap`, with `appLayer` pinned, so cached
 * services (Database, Bus, Session, …) resolve to the same instances `Server.Default()` uses.
 */
const sharedRunFor =
  <R0, E0>(appLayer: Layer.Layer<R0, E0>): Runner =>
  (value, layer) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => pinLayer(appLayer))
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
      const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(ctx), Effect.exit)
      yield* Scope.close(scope, Exit.void)
      if (Exit.isFailure(exit)) {
        for (const err of Cause.prettyErrors(exit.cause)) {
          yield* Effect.logError(err)
        }
      }
      return yield* exit
    }).pipe(Effect.runPromise)

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>, run: Runner = isolatedRun) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, testLayer), opts)

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, testLayer), opts)

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, testLayer), opts)

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, liveLayer), opts)

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, liveLayer), opts)

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, liveLayer), opts)

  const instance = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer),
      args.testOptions,
    )
  }

  instance.only = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test.only(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer),
      args.testOptions,
    )
  }

  instance.skip = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    return test.skip(
      name,
      () => run(body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer),
      args.testOptions,
    )
  }

  return { effect, live, instance }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make<never, never>(testEnv, liveEnv)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))

/**
 * Variant of `testEffect` that builds the test layer through the shared process-wide `memoMap`, with
 * `layer` PINNED for the lifetime of the process, so services like Database/Bus/Session resolve to
 * the same instances `Server.Default()` uses — and are built ONCE for the whole run instead of once
 * per test.
 *
 * ⚠️ This is the right runner for anything that composes `test/server/httpapi-layer.ts`, and
 * `test/server/httpapi-shared-run-ledger.test.ts` is the ratchet that keeps it that way. It is the
 * WRONG runner for a test whose subject is a fresh graph (a boot sequence, a build counter, a
 * migration from empty) — those want `testEffect`, and the ledger takes a stated reason instead.
 *
 * The per-test `TestClock`/`TestConsole` are still built and finalized per test; only the app layer
 * is shared. See the block above `pinLayer`.
 */
export const testEffectShared = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv), sharedRunFor(layer))

export const awaitWithTimeout = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  message: string,
  duration: Duration.Input = "2 seconds",
) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(message)),
    }),
  )

export const pollWithTimeout = <A, E, R>(
  self: Effect.Effect<A | undefined, E, R>,
  message: string,
  duration: Duration.Input = "5 seconds",
) =>
  Effect.gen(function* () {
    while (true) {
      const result = yield* self
      if (result !== undefined) return result
      yield* Effect.sleep("20 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(message)),
    }),
  )
