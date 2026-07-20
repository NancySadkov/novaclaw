import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"

// Unit tests for the memory-client surface — the engine-agnostic contract (no WASM, no server): the
// in-memory `stub`, the `disabled` degrade client, the `fromEngine` adapter, and the `proxy` swap.

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("MemoryClient.stub (in-memory)", () => {
  test("add → search (substring, scope/kind filtered) + neighbors + invalidate + purge + stats", async () => {
    const c = MemoryClient.stub()
    await run(c.addMemory({ id: "a", kind: "entity", name: "Alice", text: "Alice in Berlin", scope: "global" }))
    await run(c.addMemory({ id: "b", kind: "entity", name: "Acme", text: "Acme in Berlin", scope: "session:x" }))
    // scope filter isolates the session memory
    expect((await run(c.search({ query: "berlin", scopes: ["global"] }))).map((h) => h.id)).toEqual(["a"])
    // edge + neighbors
    await run(c.addEdge({ from: "a", to: "b", type: "rel", scope: "global" }))
    expect((await run(c.neighbors("a"))).map((n) => n.id)).toEqual(["b"])
    // invalidate drops from search but keeps the row in total
    await run(c.invalidate("a"))
    expect((await run(c.search({ query: "berlin" }))).some((h) => h.id === "a")).toBe(false)
    const s = await run(c.stats())
    expect(s.total).toBe(2)
    expect(s.valid).toBe(1)
    // purge hard-deletes
    await run(c.purge("b"))
    expect((await run(c.stats())).total).toBe(1)
  })
})

describe("MemoryClient.disabled", () => {
  test("health is false and every op fails as a MemoryError", async () => {
    const c = MemoryClient.disabled("nope")
    expect(await run(c.health())).toBe(false)
    const err = await run(c.search({ query: "x" }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(MemoryClient.MemoryError)
    expect(err.reason).toBe("nope")
    const err2 = await run(c.addMemory({ id: "x", kind: "entity", text: "", scope: "global" }).pipe(Effect.flip))
    expect(err2).toBeInstanceOf(MemoryClient.MemoryError)
  })
})

describe("MemoryClient.fromEngine", () => {
  test("adapts a Promise-based engine to the Effect Interface; faults become MemoryError", async () => {
    const calls: string[] = []
    const engine: MemoryClient.Engine = {
      addMemory: async (i) => void calls.push(`add:${i.id}`),
      addEdge: async () => {},
      search: async () => [{ id: "z", kind: "entity", text: "t", name: null, scope: "global", source: null, confidence: null, relation: "staged", score: 1 }],
      neighbors: async () => [],
      path: async () => null,
      invalidate: async () => {},
      purge: async () => {
        throw new Error("boom")
      },
      clearScope: async () => {},
      stats: async () => ({ total: 1, valid: 1 }),
      list: async () => [],
      graph: async () => ({ nodes: [], edges: [] }),
    }
    const c = MemoryClient.fromEngine(engine)
    expect(await run(c.health())).toBe(true)
    await run(c.addMemory({ id: "m1", kind: "entity", text: "hi", scope: "global" }))
    expect(calls).toEqual(["add:m1"])
    expect((await run(c.search({ query: "x" }))).map((h) => h.id)).toEqual(["z"])
    // an engine throw collapses to a MemoryError carrying the message
    const err = await run(c.purge("m1").pipe(Effect.flip))
    expect(err).toBeInstanceOf(MemoryClient.MemoryError)
    expect(err.reason).toContain("boom")
  })
})

describe("MemoryClient.proxy", () => {
  test("delegates per call — degrades until the delegate swaps to a live client", async () => {
    let delegate = MemoryClient.disabled("still opening")
    const c = MemoryClient.proxy(() => delegate)
    // before swap: disabled
    expect(await run(c.health())).toBe(false)
    expect(await run(c.stats().pipe(Effect.flip))).toBeInstanceOf(MemoryClient.MemoryError)
    // swap in a live (stub) client — the proxy now delegates to it
    delegate = MemoryClient.stub()
    expect(await run(c.health())).toBe(true)
    await run(c.addMemory({ id: "p", kind: "entity", text: "proxied", scope: "global" }))
    expect((await run(c.stats())).total).toBe(1)
  })
})

describe("stub fidelity vs the real engine", () => {
  test("a duplicate id is IGNORED, keeping the FIRST write (engine-measured semantics)", async () => {
    const c = MemoryClient.stub()
    await run(c.addMemory({ id: "dup", kind: "entity", text: "original", scope: "global" }))
    // Neither throws nor overwrites on the real engine — measured 2026-07-20.
    await run(c.addMemory({ id: "dup", kind: "entity", text: "REPLACEMENT", scope: "global" }))
    const rows = await run(c.list({ limit: 10 }))
    expect(rows).toHaveLength(1)
    // Last-write-wins here would let re-write code pass in tests and behave differently in production.
    expect(rows[0]!.text).toBe("original")
  })
})
