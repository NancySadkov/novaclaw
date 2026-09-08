import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"

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
    // ⚠️ The stored scope is DERIVED: `a` is global and `b` is session-only, so the edge is kept to
    // the narrower one. Passing `scope: "global"` no longer makes it global — that promotion was the
    // bridge NC-SEC-016 crossed.
    const edge = await run(c.addEdge({ from: "a", to: "b", type: "rel", scope: "global" }, MemoryAccess.owner()))
    expect(edge).toEqual({ ok: true, scope: "session:x" })
    // 🔴 THIS LINE USED TO PIN THE LEAK. It asserted that an unscoped `neighbors("a")` returns the
    // session-only `b` — the cross-scope traversal NC-SEC-016 describes, written down as correct
    // behaviour. A test can certify a bug as easily as it can catch one, and this one did for months.
    // The owner may still see everything, and says so:
    expect((await run(c.neighbors("a", MemoryAccess.owner()))).map((n) => n.id)).toEqual(["b"])
    // …and a caller confined to global sees the edge lead nowhere it may go.
    expect((await run(c.neighbors("a", MemoryAccess.of(["global"])))).map((n) => n.id)).toEqual([])
    // invalidate drops from search but keeps the row in total
    await run(c.invalidate("a", MemoryAccess.owner()))
    expect((await run(c.search({ query: "berlin" }))).some((h) => h.id === "a")).toBe(false)
    const s = await run(c.stats())
    expect(s.total).toBe(2)
    expect(s.valid).toBe(1)
    // purge hard-deletes
    await run(c.purge("b", MemoryAccess.owner()))
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
      addEdge: async () => ({ ok: true, scope: "global" }),
      moveScope: async (from, to) => void calls.push(`move:${from}->${to}`),
      search: async () => [
        {
          id: "z",
          kind: "entity",
          text: "t",
          name: null,
          scope: "global",
          source: null,
          status: "active",
          subject: null,
          predicate: null,
          conflictKey: null,
          supersededBy: null,
          evidence: null,
          evidenceKind: null,
          confidence: null,
          relation: "staged",
          score: 1,
        },
      ],
      neighbors: async () => [],
      get: async () => null,
      path: async () => null,
      invalidate: async () => {},
      purge: async () => {
        throw new Error("boom")
      },
      addClaim: async (i) => ({ ok: true, id: `clm:${i.statement}`, superseded: [] }),
      claimHistory: async () => null,
      reviewEvidence: async () => 0,
      setClaimStatus: async () => true,
      clearScope: async () => {},
      eraseAll: async () => 0,
      discardLegacyGlobalExtracts: async () => 0,
      stats: async () => ({ total: 1, valid: 1 }),
      list: async () => [],
      candidates: async () => [],
      byIds: async () => [],
      graph: async () => ({
        nodes: [],
        edges: [],
        slice: { partial: false, total: 0, returned: 0, omitted: 0, reason: "complete" as const },
      }),
    }
    const c = MemoryClient.fromEngine(engine)
    expect(await run(c.health())).toBe(true)
    await run(c.addMemory({ id: "m1", kind: "entity", text: "hi", scope: "global" }))
    expect(calls).toEqual(["add:m1"])
    expect((await run(c.search({ query: "x" }))).map((h) => h.id)).toEqual(["z"])
    // The lifecycle rides the same adapter. Asserted here because a new op that reaches the Interface
    // but not `fromEngine` type-checks perfectly and does nothing at run time.
    expect((await run(c.addClaim({ scope: "global", statement: "hi" }, MemoryAccess.owner()))).id).toBe("clm:hi")
    // an engine throw collapses to a MemoryError carrying the message
    const err = await run(c.purge("m1", MemoryAccess.owner()).pipe(Effect.flip))
    expect(err).toBeInstanceOf(MemoryClient.MemoryError)
    expect(err.reason).toContain("boom")
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

  test("🔴 the double REFUSES a claim written outside the caller's reach, exactly as the engine does", async () => {
    const c = MemoryClient.stub()
    const bob = MemoryAccess.of(["global", "session:bob"])
    const mine = await run(
      c.addClaim(
        { scope: "session:alice", subject: "Sofia", predicate: "employer", statement: "Sofia works at Initech." },
        MemoryAccess.owner(),
      ),
    )
    const attempt = await run(
      c.addClaim(
        { scope: "session:alice", subject: "Sofia", predicate: "employer", statement: "Sofia works at Acme." },
        bob,
      ),
    )
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toBe("refused-scope")
    // A double that let this through would certify the write-side hole rather than catch it — which is
    // the failure mode this whole describe block exists for.
    expect((await run(c.claimHistory(mine.id!, MemoryAccess.owner())))!.claim.status).toBe("active")
  })

  test("the double separates current truth from history exactly as retrieval does", async () => {
    const c = MemoryClient.stub()
    const claim = { scope: "global" as const, subject: "Sofia", predicate: "employer" }
    await run(c.addClaim({ ...claim, statement: "Sofia works at Initech." }, MemoryAccess.owner()))
    const now = await run(c.addClaim({ ...claim, statement: "Sofia works at Acme." }, MemoryAccess.owner()))
    const hits = await run(c.search({ query: "Sofia works" }))
    expect(hits.filter((hit) => hit.kind === "claim").map((hit) => hit.id)).toEqual([now.id!])
    // …and the retired one is still enumerable, because `list` has no lifecycle lens by default.
    expect((await run(c.list({ kinds: ["claim"] }))).length).toBe(2)
  })
})
