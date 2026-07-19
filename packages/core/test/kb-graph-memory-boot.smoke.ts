// LIVE boot smoke — proves the graph DB starts AS PART OF THE INSTANCE (the owner's ask). It builds
// the real boot layer (Memory.layerFromConfig, the same one `Memory.node` uses) which auto-spawns +
// supervises the on-device Node sidecar, then resolves `MemoryClient.Service` from the layer and
// round-trips a memory — exactly what the instance's service graph does at startup. Also asserts the
// two safety properties: boot is NON-BLOCKING (the client is live before the engine finishes opening,
// so we poll health) and an unconfigured instance still boots (disabled client, no spawn).
//
// ⚠️ NOT hermetic (spawns `node`, real Ladybug DB) → `.smoke.ts`, excluded from `bun run test`. Runs
// under Bun (safe: Bun only spawns node; the addon lives in the child):
//     cd packages/core && bun test ./test/kb-graph-memory-boot.smoke.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"

const ENTRY = resolve(import.meta.dir, "../../kb-sidecar/src/main.ts")
let dir: string

const waitHealthy = (mem: MemoryClient.Interface, ms = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (yield* mem.health()) return true
      yield* Effect.sleep("150 millis")
    }
    return false
  })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-mem-boot-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("graph memory boots as part of the instance", () => {
  test("a configured instance auto-starts the DB and memory round-trips", async () => {
    const layer = Memory.layerFromConfig({ entry: ENTRY, dim: 8, dbPath: join(dir, "graph") })
    const program = Effect.gen(function* () {
      const mem = yield* MemoryClient.Service
      // Boot is non-blocking — the engine opens in the background; wait for it.
      expect(yield* waitHealthy(mem)).toBe(true)
      yield* mem.addMemory({ id: "u1", kind: "entity", name: "Nadia", text: "Nadia prefers dark mode", scope: "global" })
      const hits = yield* mem.search({ query: "dark mode", k: 5 })
      expect(hits.some((h) => h.id === "u1")).toBe(true)
    })
    // Effect.scoped runs the layer's release finalizer (stop the sidecar) on teardown.
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void>)
  }, 30_000)

  test("an unconfigured instance still boots — memory is disabled, not a hard dependency", async () => {
    const layer = Memory.layerFromConfig({}) // no entry
    const program = Effect.gen(function* () {
      const mem = yield* MemoryClient.Service
      expect(yield* mem.health()).toBe(false)
      // Ops fail as a MemoryError (degrade), but nothing spawned and boot succeeded.
      const err = yield* mem.search({ query: "x" }).pipe(Effect.flip)
      expect(err).toBeInstanceOf(MemoryClient.MemoryError)
    })
    await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<void>)
  })
})
