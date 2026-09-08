import { afterEach, describe, expect } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { testEffect } from "./lib/effect"

/**
 * ─── THE FORGETTING PASS, THROUGH THE LOOP THAT ACTUALLY RUNS IT ─────────────────────────────────
 *
 * 🔴 **What was proven before this file, and what was not.** `prune-policy.test.ts` proves the
 * CHOICE — given candidates and a usage rollup, which ones go. `kb-graph-forgetting-pass.test.ts`
 * proves `forgetEverywhere` against a real engine and a real ledger. Neither touches the thing that
 * calls it: the `Effect.forkScoped` loop inside `Memory.layerFromConfig`, which sleeps
 * `consolidateEveryMs`, checks `MemorySetting.memoryEnabled()`, consolidates, and only then forgets.
 * Every one of those steps is a way for eviction to never happen while all three suites stay green —
 * and that is the shape of "a feature can be built, tested, and never called".
 *
 * So this drives the WHOLE layer: build it, write past the cap through the client the instance
 * publishes, and wait for the store to shrink on its own.
 *
 * ⚠️ **`it.live`, never `it.effect`.** The claim here IS a duration — the loop sleeps
 * `consolidateEveryMs` — and `it.effect` runs under a `TestClock` that never advances on its own, so
 * the fiber would sit in its first sleep forever and the test would read as a deadlock rather than a
 * failure.
 *
 * ⚠️ The rows are `source: "ingest"`, not `"auto-extract"`. A `global` + `auto-extract` row is what
 * `discardLegacyGlobalExtracts` deletes during the first real store open, so a corpus written that
 * way would vanish for a reason that has nothing to do with forgetting, and the test would pass
 * while proving nothing.
 */

const it = testEffect(Database.layerFromPath(":memory:"))

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** Every event the store published, so the pass can be checked by what it ANNOUNCED as well as by
 *  what it left behind — the two are separately breakable. */
const recorder = () => {
  const published: Array<{ type: string; data: unknown }> = []
  const events = {
    publish: (definition: { type: string }, data: unknown) => {
      published.push({ type: definition.type, data })
      return Effect.succeed({ id: EventV2.ID.create(), type: definition.type, data })
    },
  } as unknown as EventV2.Interface
  return { published, layer: Layer.succeed(EventV2.Service, events) }
}

const staged = (memory: MemoryClient.Interface, scope: string) =>
  memory
    .list({ scopes: [scope], limit: 200 })
    .pipe(Effect.map((rows) => rows.filter((row) => row.relation === "staged").map((row) => row.id)))

/** Wait for a predicate, on the REAL clock, with a named bound. Never an unbounded poll. */
const until = <A>(read: Effect.Effect<A, MemoryClient.MemoryError>, done: (value: A) => boolean, ms = 25_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    let last = yield* read
    while (Date.now() < deadline) {
      if (done(last)) return last
      yield* Effect.sleep("150 millis")
      last = yield* read
    }
    return last
  })

const runWithMemory = <A>(
  config: Omit<Memory.MemoryConfig, "enabled" | "dbDir" | "dim">,
  program: (memory: MemoryClient.Interface) => Effect.Effect<A, MemoryClient.MemoryError>,
) =>
  Effect.gen(function* () {
    const bus = recorder()
    dir = mkdtempSync(join(tmpdir(), "kb-forget-loop-"))
    const layer = Memory.layerFromConfig({ enabled: true, dim: 8, dbDir: join(dir, "graph"), ...config })
    const value = yield* Effect.gen(function* () {
      const memory = yield* MemoryClient.Service
      // The engine is LAZY, so the first operation is what opens it; the loop's own `engine` is
      // `undefined` until then and the pass is a no-op. Waiting for health here is not politeness,
      // it is the precondition the loop has.
      yield* until(memory.health(), (ok) => ok, 25_000)
      return yield* program(memory)
    }).pipe(Effect.provide(layer.pipe(Layer.provide(bus.layer))), Effect.scoped)
    return { value, published: bus.published }
  })

const fill = (memory: MemoryClient.Interface, scope: string, ids: readonly string[]) =>
  Effect.forEach(
    ids,
    (id) =>
      memory
        .addMemory({
          id,
          kind: "episode",
          text: `${scope} remembers ${id}`,
          scope,
          relation: "staged",
          source: "ingest",
        })
        // ⚠️ Rows written inside one clock tick share a `t_created`, and the policy's TIEBREAK is
        // age — without a gap an ordering assertion is flaky rather than wrong.
        .pipe(Effect.andThen(Effect.sleep("15 millis"))),
    { discard: true },
  )

describe("the background loop actually forgets", () => {
  it.live(
    "a cleanup against a store that never existed does not allocate the WASM engine",
    () =>
      Effect.gen(function* () {
        const bus = recorder()
        dir = mkdtempSync(join(tmpdir(), "kb-absent-cleanup-"))
        const graph = join(dir, "graph")
        const layer = Memory.layerFromConfig({ enabled: true, dim: 8, dbDir: graph })
        yield* Effect.gen(function* () {
          const memory = yield* MemoryClient.Service
          yield* memory.clearScope("session:already-gone")
          yield* memory.moveScope("agent:already-gone", "retired:already-gone")
        }).pipe(Effect.provide(layer.pipe(Layer.provide(bus.layer))), Effect.scoped)

        // Both calls are no-ops only because there are no bytes to mutate. Creating `graph` would
        // mean teardown started the 1.3 GB engine merely to discover the same fact expensively.
        expect(existsSync(graph)).toBe(false)
      }),
    10_000,
  )

  it.live(
    "🔴 a household pile written past its cap is evicted BY THE LOOP, with nobody asking",
    () =>
      Effect.gen(function* () {
        const outcome = yield* runWithMemory({ consolidateEveryMs: 250, globalStagedCap: 3 }, (memory) =>
          Effect.gen(function* () {
            yield* fill(memory, "global", ["g1", "g2", "g3", "g4", "g5", "g6"])
            // ⚠️ All six ARRIVED — asserted against the store INCLUDING invalid rows, because at a
            // 250 ms interval the loop can already have evicted three by the time this line runs.
            // (It did, on the first run of this test.) Without this the test below could be green
            // over a store that never received the writes at all.
            const written = yield* memory.list({ scopes: ["global"], includeInvalid: true, limit: 200 })
            expect(written.filter((row) => row.id.startsWith("g")).length).toBe(6)
            // Nothing is asked of the pass here. The loop is the subject.
            return yield* until(staged(memory, "global"), (ids) => ids.length <= 3)
          }),
        )
        expect(outcome.value.length).toBe(3)
        // …and it ANNOUNCED the forgetting. A store that shrank silently would leave the Memory app
        // showing memories that are gone until something else made it re-read.
        const forgotten = outcome.published.filter((event) => event.type === "memory.forgotten")
        expect(forgotten.length).toBe(3)
        expect(new Set(forgotten.map((event) => (event.data as { mode: string }).mode))).toEqual(
          new Set(["invalidate"]),
        )
      }),
    60_000,
  )

  it.live(
    "a pile INSIDE its cap is left alone — the control, so the eviction above means something",
    () =>
      Effect.gen(function* () {
        const outcome = yield* runWithMemory({ consolidateEveryMs: 250, globalStagedCap: 50 }, (memory) =>
          Effect.gen(function* () {
            yield* fill(memory, "global", ["g1", "g2", "g3", "g4", "g5", "g6"])
            // Long enough for several passes to have run and decided to do nothing. Without this the
            // test above could pass because the loop evicts indiscriminately.
            yield* Effect.sleep("2500 millis")
            return yield* staged(memory, "global")
          }),
        )
        expect(outcome.value.length).toBe(6)
        expect(outcome.published.filter((event) => event.type === "memory.forgotten").length).toBe(0)
      }),
    60_000,
  )

  it.live(
    "🔴 each COLLEAGUE's cabinet is capped on its own — one talkative officer cannot spend another's",
    () =>
      Effect.gen(function* () {
        const outcome = yield* runWithMemory({ consolidateEveryMs: 250, globalStagedCap: 3 }, (memory) =>
          Effect.gen(function* () {
            yield* fill(memory, "agent:loud", ["l1", "l2", "l3", "l4", "l5", "l6"])
            yield* fill(memory, "agent:quiet", ["q1", "q2"])
            yield* until(staged(memory, "agent:loud"), (ids) => ids.length <= 3)
            return {
              loud: yield* staged(memory, "agent:loud"),
              quiet: yield* staged(memory, "agent:quiet"),
            }
          }),
        )
        expect(outcome.value.loud.length).toBe(3)
        // Under one cap across `agent:%` the quiet colleague's two memories would be the cheapest
        // thing in the pile to evict — it is the one that never spoke.
        expect(outcome.value.quiet.length).toBe(2)
      }),
    60_000,
  )
})
