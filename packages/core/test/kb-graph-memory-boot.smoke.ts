// Boot smoke — proves the graph DB starts AS PART OF THE INSTANCE, now via the in-process WASM engine
// (§2.0). Builds the real inner layer (`Memory.layerFromConfig`, used by `Memory.serviceNode`), which
// resolves a lightweight MemoryClient.Service, then opens the engine on its first operation and
// round-trips a memory. Asserts the safety properties: UNUSED INSTANCES STAY UNLOADED and an
// unconfigured instance still boots (disabled client).
//
// Runs under the Bun suite (WASM, no native addon) — this could fold into the hermetic suite, but it
// opens a real graph + writes temp files, so it's kept a `.smoke.ts`:
//     cd packages/core && bun test ./test/kb-graph-memory-boot.smoke.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import { enforce } from "../../../script/lib/heavy-guard"

// Opening the real WASM graph engine consumes roughly 2 GiB on Windows. This smoke is deliberately
// outside the normal suite, so it must carry the same non-bypassable admission check itself.
enforce("the graph-memory smoke test", process.argv, {
  allowOverride: false,
  requireMeasurement: true,
})

let dir: string

const waitHealthy = (mem: MemoryClient.Interface, ms = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (yield* mem.health()) return true
      yield* Effect.sleep("100 millis")
    }
    return false
  })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-mem-boot-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("graph memory boots as part of the instance (in-process WASM)", () => {
  test("an enabled instance opens the DB in-process and memory round-trips", async () => {
    const layer = Memory.layerFromConfig({ enabled: true, dim: 8, dbDir: join(dir, "graph") })
    const program = Effect.gen(function* () {
      const mem = yield* MemoryClient.Service
      expect(Memory.runtimeStatus().stage).toBe("not-loaded")
      expect(yield* waitHealthy(mem)).toBe(true)
      expect(Memory.runtimeStatus().stage).toBe("ready")
      yield* mem.addMemory({
        id: "u1",
        kind: "entity",
        name: "Nadia",
        text: "Nadia prefers dark mode",
        scope: "global",
      })
      const hits = yield* mem.search({ query: "dark mode", k: 5 })
      expect(hits.some((h) => h.id === "u1")).toBe(true)
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void>)
  }, 30_000)

  test("the background consolidation fiber promotes a session fact to global (cross-session)", async () => {
    // A short interval so the fiber fires during the test instead of the 5-min default.
    const layer = Memory.layerFromConfig({
      enabled: true,
      dim: 8,
      dbDir: join(dir, "consolidate"),
      consolidateEveryMs: 300,
    })
    const program = Effect.gen(function* () {
      const mem = yield* MemoryClient.Service
      expect(yield* waitHealthy(mem)).toBe(true)
      yield* mem.addMemory({
        id: "sess1",
        kind: "episode",
        text: "The user drives a Saab",
        scope: "session:demo",
        source: "auto-extract",
      })
      // Not global yet.
      expect(yield* mem.search({ query: "Saab", scopes: ["global"] })).toHaveLength(0)
      // Wait for the background consolidation pass to promote it.
      for (let i = 0; i < 40; i++) {
        if ((yield* mem.search({ query: "Saab", scopes: ["global"] })).length > 0) break
        yield* Effect.sleep("150 millis")
      }
      const global = yield* mem.search({ query: "Saab", scopes: ["global"] })
      expect(global).toHaveLength(1)
      expect(global[0]!.scope).toBe("global")
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void>)
  }, 30_000)

  test("the explicit KB and hot world model are separate on-disk graphs", async () => {
    const explicitDir = join(dir, "separation-graph")
    const worldDir = join(dir, "separation-world")

    // Open only one WASM engine at a time: the real graph is intentionally a heavy resource on
    // this host. The two passes still exercise independent layers and independent directories,
    // which is the boundary the runner relies on.
    const explicit = Memory.layerFromConfig({ enabled: true, dim: 8, dbDir: explicitDir })
    await Effect.runPromise(
      Effect.gen(function* () {
        const mem = yield* MemoryClient.Service
        expect(yield* waitHealthy(mem)).toBe(true)
        yield* mem.addMemory({
          id: "explicit-only",
          kind: "entity",
          text: "The explicit KB owns this source fact",
          scope: "global",
          source: "ingest",
        })
        expect(yield* mem.search({ query: "source fact" })).toHaveLength(1)
        expect(yield* mem.search({ query: "hot world" })).toHaveLength(0)
      }).pipe(Effect.provide(explicit), Effect.scoped) as Effect.Effect<void>,
    )

    const world = WorldMemory.layerFromConfig({ enabled: true, dim: 8, dbDir: worldDir })
    await Effect.runPromise(
      Effect.gen(function* () {
        const mem = yield* WorldMemory.Service
        expect(yield* waitHealthy(mem)).toBe(true)
        // If the world accidentally opened the explicit graph, this query would see its marker.
        expect(yield* mem.search({ query: "source fact" })).toHaveLength(0)
        yield* mem.addMemory({
          id: "world-only",
          kind: "episode",
          text: "The hot world keeps this transient conversation fact",
          scope: "session:demo",
          source: "auto-extract",
        })
        expect(yield* mem.search({ query: "transient conversation" })).toHaveLength(1)
      }).pipe(Effect.provide(world), Effect.scoped) as Effect.Effect<void>,
    )
  }, 40_000)

  test("a disabled instance still boots — memory degrades, not a hard dependency", async () => {
    const layer = Memory.layerFromConfig({ enabled: false })
    const program = Effect.gen(function* () {
      const mem = yield* MemoryClient.Service
      expect(yield* mem.health()).toBe(false)
      const err = yield* mem.search({ query: "x" }).pipe(Effect.flip)
      expect(err).toBeInstanceOf(MemoryClient.MemoryError)
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void>)
  })
})
