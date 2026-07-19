import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WasmMemory } from "@novaclaw/core/kb-graph/wasm-engine"

// The in-process WASM engine — runs under the BUN suite (WASM has no native addon, unlike the retired
// sidecar). Verifies the full feature set (graph + built-in vector + FTS + bitemporal) AND the
// MEMFS→disk snapshot persistence, including cross-"process" durability (close → reopen a fresh store
// from the same real dir).

const DIM = 8
const vec = (i: number): number[] => {
  const v = new Array(DIM).fill(0)
  v[i % DIM] = 1
  return v
}

let dir: string
let mem: WasmMemory

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-wasm-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
})
afterAll(async () => {
  await mem?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("WasmMemory (in-process, everywhere)", () => {
  test("add + hybrid search (vector + FTS both contribute)", async () => {
    await mem.addMemory({ id: "alice", kind: "entity", name: "Alice", text: "Alice lives in Berlin", scope: "global", embedding: vec(0) })
    await mem.addMemory({ id: "acme", kind: "entity", name: "Acme", text: "Acme is based in Berlin", scope: "global", embedding: vec(1) })
    const hits = await mem.search({ query: "Berlin", embedding: vec(0), k: 5 })
    const ids = new Set(hits.map((h) => h.id))
    expect(ids.has("alice") && ids.has("acme")).toBe(true)
  })

  test("edges: neighbors + shortest path", async () => {
    await mem.addEdge({ from: "alice", to: "acme", type: "works_at", scope: "global" })
    expect((await mem.neighbors("alice")).map((n) => n.id)).toEqual(["acme"])
    expect((await mem.path("alice", "acme", 3))?.hops).toBe(1)
  })

  test("bitemporal invalidate drops from search but keeps history in stats", async () => {
    await mem.addMemory({ id: "temp", kind: "episode", text: "Zorblatt happened", scope: "global", embedding: vec(2) })
    await mem.invalidate("temp")
    expect((await mem.search({ query: "Zorblatt", k: 5 })).some((h) => h.id === "temp")).toBe(false)
    const s = await mem.stats()
    expect(s.total).toBeGreaterThan(s.valid)
  })

  test("scope isolation + secret purge", async () => {
    await mem.addMemory({ id: "sec", kind: "entity", text: "password hunter2", scope: "session:x", embedding: vec(3) })
    expect((await mem.search({ query: "hunter2", scopes: ["global"] })).some((h) => h.id === "sec")).toBe(false)
    await mem.purge("sec")
    expect((await mem.search({ query: "hunter2" })).some((h) => h.id === "sec")).toBe(false)
  })

  test("PERSISTENCE — flush snapshots to disk; a fresh store reopens the same graph", async () => {
    await mem.flush()
    // Real dir now holds the snapshot file(s).
    expect(readdirSync(join(dir, "graph")).length).toBeGreaterThan(0)
    const reopened = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
    const hits = await reopened.search({ query: "Berlin", k: 5 })
    expect(new Set(hits.map((h) => h.id)).has("alice")).toBe(true)
    // and the invalidated 'temp' stayed invalid across reopen (bitemporal survived the snapshot)
    expect((await reopened.search({ query: "Zorblatt", k: 5 })).some((h) => h.id === "temp")).toBe(false)
    await reopened.close()
  })

  test("list enumerates (no query) + graph returns nodes and the edges among them", async () => {
    const g = await WasmMemory.open(join(dir, "listgraph"), { dim: DIM })
    await g.addMemory({ id: "p", kind: "entity", name: "Alice", text: "Alice", scope: "global" })
    await g.addMemory({ id: "q", kind: "entity", name: "Acme", text: "Acme", scope: "global" })
    await g.addMemory({ id: "r", kind: "episode", text: "old news", scope: "session:z" })
    await g.invalidate("r")
    await g.addEdge({ from: "p", to: "q", type: "works_at", scope: "global" })

    // list: valid only by default; scope + kind filters; invalidated 'r' excluded.
    const all = await g.list()
    expect(all.map((m) => m.id).sort()).toEqual(["p", "q"])
    expect((await g.list({ scopes: ["global"], kinds: ["entity"] })).length).toBe(2)
    expect((await g.list({ includeInvalid: true })).some((m) => m.id === "r")).toBe(true)

    // graph: nodes + the edge among them (no dangling endpoints).
    const graph = await g.graph()
    expect(new Set(graph.nodes.map((n) => n.id))).toEqual(new Set(["p", "q"]))
    expect(graph.edges).toEqual([{ from: "p", to: "q", type: "works_at" }])
    await g.close()
  })

  test("consolidate promotes session memories to global, dedups across sessions, is idempotent", async () => {
    const c = await WasmMemory.open(join(dir, "consolidate"), { dim: DIM })
    // Two sessions; the "lives in Kyoto" fact is stated in BOTH (same content).
    await c.addMemory({ id: "s1a", kind: "episode", text: "The user lives in Kyoto", scope: "session:a", source: "auto-extract" })
    await c.addMemory({ id: "s1b", kind: "episode", text: "The user likes Haskell", scope: "session:a", source: "auto-extract" })
    await c.addMemory({ id: "s2a", kind: "episode", text: "The user lives in Kyoto", scope: "session:b", source: "auto-extract" })
    // A deliberate "this chat only" note (no auto-extract source) must NOT be promoted.
    await c.addMemory({ id: "note", kind: "entity", text: "Ephemeral chat note about pandas", scope: "session:a" })

    const promoted = await c.consolidate()
    expect(promoted).toBe(3) // the three auto-extracted originals; the deliberate note is left alone

    // The deliberate session-only note stayed put (session, not global).
    expect((await c.search({ query: "pandas", scopes: ["global"] }))).toHaveLength(0)
    expect((await c.search({ query: "pandas", scopes: ["session:a"] }))).toHaveLength(1)

    // A GLOBAL-only search now finds both facts (cross-session), deduped to one Kyoto memory.
    const kyoto = await c.search({ query: "Kyoto", scopes: ["global"] })
    expect(kyoto).toHaveLength(1)
    expect(kyoto[0]!.scope).toBe("global")
    expect((await c.search({ query: "Haskell", scopes: ["global"] }))).toHaveLength(1)

    // The session originals were superseded (invalidated) — no longer in a session-scoped search.
    expect((await c.search({ query: "Kyoto", scopes: ["session:a", "session:b"] }))).toHaveLength(0)

    // Idempotent: a second pass finds nothing left to promote.
    expect(await c.consolidate()).toBe(0)
    await c.close()
  })
})
