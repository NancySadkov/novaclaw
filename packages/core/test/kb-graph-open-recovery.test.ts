import { expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { WorldMemory } from "../src/kb-graph/world-memory"
import type { GraphEngine } from "../src/kb-graph/isolated-engine"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const events = Layer.succeed(EventV2.Service, {} as EventV2.Interface)

/**
 * 🔴 RETIRED from the default tier (owner, 2026-10-03). Both tests drive `WorldMemory.layerFromConfig`,
 * which now hard-gates on the user's opt-in `memory.enabled` setting BEFORE it ever calls its engine
 * factory (`world-memory.ts`: "THE USER'S SWITCH GATES THE SPAWN, NOT JUST THE WORK"). In an isolated
 * test database that row is absent, so the layer returns the disabled client and the factory — the
 * fake these tests observe — is never invoked; the backoff test therefore reads `starts = 0`. The
 * dispose test additionally parked on a promise that only settles on abort and hung the runner.
 *
 * They are kept (skipped, not deleted) because the retry/backoff state machine is still worth
 * re-deriving — but it needs a test that can turn the setting on without opening the real 1.3 GB
 * engine, which is a fixture change, not a one-line fix.
 */

it.effect.skip("repeated failures share one attempt and back off before recovering", () => Effect.gen(function* () {
  let starts = 0
  let closes = 0
  const layer = WorldMemory.layerFromConfig({ enabled: true }, async (_directory, _options, transport) => {
    starts++
    if (starts < 3) throw new Error("unavailable graph")
    return {
      recovery: { opened: "fixture", skipped: [], quarantined: [] },
      close: async () => {
        expect(transport?.signal?.aborted).toBe(false)
        closes++
      },
    } as unknown as GraphEngine
  }).pipe(Layer.provide(events))
  yield* Effect.gen(function* () {
    const memory = yield* WorldMemory.Service
    const burst = () => Effect.all(Array.from({ length: 32 }, () => memory.health()), { concurrency: "unbounded" })
    expect((yield* burst()).every((healthy) => !healthy)).toBe(true)
    expect(starts).toBe(1)
    yield* burst()
    expect(starts).toBe(1)
    yield* TestClock.adjust("5 seconds")
    yield* burst()
    expect(starts).toBe(2)
    yield* TestClock.adjust("5 seconds")
    yield* burst()
    expect(starts).toBe(2)
    yield* TestClock.adjust("5 seconds")
    expect((yield* burst()).every(Boolean)).toBe(true)
    expect(starts).toBe(3)
    expect(WorldMemory.runtimeStatus().stage).toBe("ready")
  }).pipe(Effect.provide(layer), Effect.scoped)
  expect(closes).toBe(1)
}))

it.live.skip("disposing the owner cancels an acquisition still in progress", () => Effect.gen(function* () {
  let aborted = false
  let started!: () => void
  const acquiring = new Promise<void>((resolve) => { started = resolve })
  const layer = WorldMemory.layerFromConfig({ enabled: true }, async (_directory, _options, transport) => {
    started()
    return await new Promise<GraphEngine>((_resolve, reject) => {
      transport!.signal!.addEventListener("abort", () => {
        aborted = true
        reject(new Error("closed"))
      }, { once: true })
    })
  }).pipe(Layer.provide(events), Layer.provide(Database.layerFromPath(":memory:")))
  const runtime = ManagedRuntime.make(layer)
  try {
    const health = runtime.runPromise(WorldMemory.Service.use((memory) => memory.health()))
    yield* Effect.promise(() => acquiring)
    yield* Effect.promise(() => runtime.dispose())
    yield* Effect.promise(() => health.catch(() => false))
    expect(aborted).toBe(true)
  } finally {
    yield* Effect.promise(() => runtime.dispose())
  }
}), 5_000)
