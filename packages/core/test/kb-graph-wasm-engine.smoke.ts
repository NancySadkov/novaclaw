import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
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

  test("search returns VALID time, and an explicit validFrom is honoured (the P8 recency signal)", async () => {
    const e = await WasmMemory.open(join(dir, "validat"), { dim: DIM })
    const when = "2001-02-03T04:05:06.000Z"
    await e.addMemory({ id: "dated", kind: "entity", text: "Zyxxaton was declared", scope: "global", validFrom: when })
    await e.addMemory({ id: "undated", kind: "entity", text: "Zyxxaton mentioned again", scope: "global" })
    const hits = await e.search({ query: "Zyxxaton", k: 5 })
    const dated = hits.find((h) => h.id === "dated")
    const undated = hits.find((h) => h.id === "undated")
    expect(dated?.validAt).toBeDefined()
    // The ranker keys off this — if the engine dropped it, recency would silently do nothing.
    expect(Date.parse(dated!.validAt!)).toBe(Date.parse(when))
    // An unset validFrom still gets a time (defaults to now), so recency is defined for every memory.
    expect(undated?.validAt).toBeDefined()
    expect(Date.parse(undated!.validAt!)).toBeGreaterThan(Date.parse(when))
    await e.close()
  }, 30_000)

  test("embed backfill: the pending queue drains, terminates, and a backfilled vector is searchable", async () => {
    const e = await WasmMemory.open(join(dir, "backfill"), { dim: DIM })
    // Two memories stored with NO vector (the pre-device / device-down case) and one already embedded.
    await e.addMemory({ id: "b1", kind: "entity", text: "Backfill one", scope: "global" })
    await e.addMemory({ id: "b2", kind: "entity", text: "Backfill two", scope: "global" })
    await e.addMemory({ id: "b3", kind: "entity", text: "Already vectorised", scope: "global", embedding: vec(5) })

    // The queue holds exactly the un-embedded ones — an already-embedded memory must never re-queue,
    // or the drain would loop forever re-embedding the same rows.
    const pending = await e.pendingEmbeddings(10)
    expect(new Set(pending.map((p) => p.id))).toEqual(new Set(["b1", "b2"]))
    expect(pending.every((p) => p.text.length > 0)).toBe(true) // the drain needs text to embed

    for (const row of pending) await e.setEmbedding(row.id, vec(row.id === "b1" ? 6 : 7))

    // Drained: the queue is now empty, so the background pass settles instead of spinning.
    expect(await e.pendingEmbeddings(10)).toEqual([])

    // The payoff: a backfilled memory is now reachable through the VECTOR leg, not just FTS.
    const hits = await e.search({ embedding: vec(6), k: 3 })
    expect(hits.some((h) => h.id === "b1")).toBe(true)

    // Guard the dimension contract — a mismatched vector would corrupt the index.
    await expect(e.setEmbedding("b1", [1, 2, 3])).rejects.toThrow(/!=/)
    await e.close()
  }, 30_000)

  test("prune evicts by IMPORTANCE tier, not FIFO — deliberate memories outlive bulk ingest", async () => {
    // Uses an ISOLATED SCOPE on the shared engine rather than opening another WasmMemory: each open
    // holds its own WASM heap, and enough of them exhausts the JS heap mid-suite.
    const S = "prunetier"
    // The deliberate memory is written FIRST (oldest), so a FIFO policy would evict it first.
    await mem.addMemory({ id: "pt_kept", kind: "entity", text: "The user deliberately remembered this", scope: S })
    await mem.addMemory({ id: "pt_auto1", kind: "episode", text: "auto noted one", scope: S, source: "auto-extract" })
    await mem.addMemory({ id: "pt_auto2", kind: "episode", text: "auto noted two", scope: S, source: "auto-extract" })
    for (let i = 0; i < 3; i++)
      await mem.addMemory({ id: `pt_doc${i}`, kind: "passage", text: `ingested passage ${i}`, scope: S, source: "ingest" })

    // 6 staged, cap 3 ⇒ the 3 least valuable go: the ingested passages (bulk AND re-derivable).
    expect(await mem.prune({ scope: S, maxStaged: 3 })).toBe(3)
    const left = new Set((await mem.list({ scopes: [S], limit: 50 })).map((m) => m.id))
    expect(left.has("pt_kept")).toBe(true) // the OLDEST — FIFO would have killed it first
    expect([...left].some((id) => id.startsWith("pt_doc"))).toBe(false)

    // Squeeze harder: auto-extract goes before the deliberate memory.
    expect(await mem.prune({ scope: S, maxStaged: 1 })).toBe(2)
    expect((await mem.list({ scopes: [S], limit: 50 })).map((m) => m.id)).toEqual(["pt_kept"])
  }, 30_000)

  test("self-heals a stale non-directory at realDir (retired native-sidecar file) instead of bricking", async () => {
    // The retired native sidecar persisted the graph as a single FILE named `graph`; the WASM engine
    // expects that path to be a snapshot DIRECTORY. Opening over the stale file must recover (discard +
    // start fresh) — memory is re-derivable — not throw ENOTDIR and silently degrade memory to disabled.
    const stale = join(dir, "stale-native-db")
    writeFileSync(stale, "native single-file db leftover")
    expect(statSync(stale).isDirectory()).toBe(false)
    const healed = await WasmMemory.open(stale, { dim: DIM })
    expect(statSync(stale).isDirectory()).toBe(true)
    await healed.addMemory({ id: "h", kind: "entity", text: "healed", scope: "global" })
    expect((await healed.list()).some((m) => m.id === "h")).toBe(true)
    await healed.close()
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
    // An auto-extracted RELATIONSHIP between two promoted facts. This assertion exists because its
    // absence let a real bug ship: consolidation promoted nodes but silently dropped every edge, so
    // ~5 min after a chat the graph collapsed to disconnected facts (measured live: 3 nodes + 2 edges
    // -> 3 global nodes + 0 edges). Asserting node promotion alone cannot catch that.
    await c.addEdge({ from: "s1a", to: "s1b", type: "same_person", scope: "session:a", source: "auto-extract" })

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

    // The EDGE was carried onto the global twins — the relationship survives consolidation.
    const promotedGraph = await c.graph({ scopes: ["global"] })
    expect(promotedGraph.edges).toHaveLength(1)
    expect(promotedGraph.edges[0]!.type).toBe("same_person")
    // ...and it connects the twins of the two originals, not some other pair.
    const nameOf = new Map(promotedGraph.nodes.map((n) => [n.id, n.text]))
    expect(nameOf.get(promotedGraph.edges[0]!.from)).toBe("The user lives in Kyoto")
    expect(nameOf.get(promotedGraph.edges[0]!.to)).toBe("The user likes Haskell")

    // Idempotent: a second pass finds nothing left to promote.
    expect(await c.consolidate()).toBe(0)
    // ...and does NOT duplicate the carried edge (consolidation re-runs every ~5 min in production).
    expect((await c.graph({ scopes: ["global"] })).edges).toHaveLength(1)
    await c.close()
  }, 30_000) // heavy: many WASM ops + two consolidate passes — the 5s default flakes under suite/CI load
})
