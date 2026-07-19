// Boot smoke — proves the graph DB starts AS PART OF THE INSTANCE, now via the in-process WASM engine
// (§2.0). Builds the real boot layer (Memory.layerFromConfig, the same one Memory.node uses), which
// opens the engine in-process in a background fiber, then resolves MemoryClient.Service and round-trips
// a memory. Asserts the safety properties: NON-BLOCKING (the client is live before the engine finishes
// opening — we poll health) and an unconfigured instance still boots (disabled client).
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
      // Non-blocking boot — the engine opens in the background; wait for it.
      expect(yield* waitHealthy(mem)).toBe(true)
      yield* mem.addMemory({ id: "u1", kind: "entity", name: "Nadia", text: "Nadia prefers dark mode", scope: "global" })
      const hits = yield* mem.search({ query: "dark mode", k: 5 })
      expect(hits.some((h) => h.id === "u1")).toBe(true)
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void>)
  }, 30_000)

  test("the background consolidation fiber promotes a session fact to global (cross-session)", async () => {
    // A short interval so the fiber fires during the test instead of the 5-min default.
    const layer = Memory.layerFromConfig({ enabled: true, dim: 8, dbDir: join(dir, "consolidate"), consolidateEveryMs: 300 })
    const program = Effect.gen(function* () {
      const mem = yield* MemoryClient.Service
      expect(yield* waitHealthy(mem)).toBe(true)
      yield* mem.addMemory({ id: "sess1", kind: "episode", text: "The user drives a Saab", scope: "session:demo", source: "auto-extract" })
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
