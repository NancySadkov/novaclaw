import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as MemoryAccess from "./memory-access"
import { WasmMemory } from "./wasm-engine"

/**
 * THE SCOPE BOUNDARY, against the engine that ships — NC-SEC-016's acceptance test.
 *
 * 🔴 Measured on this engine at HEAD on 2026-08-25, BEFORE the fix, and every line of it reproduced:
 *
 *     search({ scopes: ["global", "session:bob"] })  -> []                 (already enforced)
 *     neighbors("G")                                 -> S and O, WITH TEXT
 *     path("G", "S")                                 -> { hops: 1 }
 *     invalidate("S")                                -> succeeded
 *     purge("O")                                     -> succeeded, row gone
 *
 * `G` is global, `S` is one chat's private memory, `O` is one colleague's cabinet. A global node
 * bridging to a private one disclosed that node's id and text to any other chat, which could then
 * destroy it — no id guessing, no elevated permission, no plugin. The bridge is an ordinary relation
 * the model-facing `kb` tool creates.
 *
 * ⚠️ The mechanism was that the scope set was OPTIONAL, so a call site that forgot got a WIDER query
 * rather than an error. The fix is the required `MemoryAccess` parameter; these tests prove the
 * enforcement underneath it, in BOTH directions — refuses the stranger, still serves the owner. A
 * containment test that only proves refusal has not shown the product still works.
 */

const DIM = 8
const ALICE = ["global", "session:alice"]
const BOB = ["global", "session:bob"]
const LYSANDER = ["global", "agent:lysander"]

let dir: string
let mem: WasmMemory

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-access-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
  await mem.addMemory({ id: "G", kind: "entity", name: "Public", text: "a shared thing", scope: "global" })
  await mem.addMemory({ id: "S", kind: "entity", name: "Secret", text: "ALICE ONLY", scope: "session:alice" })
  await mem.addMemory({ id: "O", kind: "entity", name: "Cabinet", text: "LYSANDER ONLY", scope: "agent:lysander" })
  // The bridge: an ordinary relation from a shared memory to two private ones.
  await mem.addEdge({ from: "G", to: "S", type: "rel", scope: "global" })
  await mem.addEdge({ from: "G", to: "O", type: "rel", scope: "global" })
  // A second hop, so a PATH can be asked to cross a private node it never lands on.
  await mem.addEdge({ from: "S", to: "O", type: "rel", scope: "global" })
  // ⚠️ SEPARATE nodes for the tests that MUTATE. Reusing S and O coupled this file to its own
  // execution order — the owner test read a node an earlier test had invalidated and failed for a
  // reason that had nothing to do with access. Order-coupled fixtures are how a suite starts passing
  // or failing on shard layout rather than on behaviour.
  await mem.addMemory({ id: "S_own", kind: "entity", name: "Alice's", text: "ALICE ONLY", scope: "session:alice" })
  // ⚠️ A GLOBAL neighbour of a PRIVATE node. Without it the source-check test passes even with the
  // check removed — S's only neighbour was Lysander's, which a target-only filter hides anyway. The
  // A/B is what exposed that: five tests reddened and this one did not, so it was proving nothing.
  await mem.addMemory({ id: "G2", kind: "entity", name: "AlsoPublic", text: "also shared", scope: "global" })
  await mem.addEdge({ from: "S", to: "G2", type: "rel", scope: "global" })
}, 120_000)

afterAll(async () => {
  await mem?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("a stranger cannot READ across the boundary", () => {
  test("🔴 neighbors of a shared node do not disclose another chat's private one", async () => {
    const seen = await mem.neighbors("G", { scopes: BOB })
    expect(seen.map((n) => n.id)).toEqual([])
    // Not merely absent from the ids — the TEXT is what the disclosure was.
    expect(JSON.stringify(seen)).not.toContain("ALICE ONLY")
    expect(JSON.stringify(seen)).not.toContain("LYSANDER ONLY")
  })

  test("🔴 the SOURCE node is checked too — knowing a private id is not permission to walk from it", async () => {
    // `S -> G2` joins Alice's private memory to a GLOBAL one. A filter that only looks at targets
    // happily returns G2, which confirms to Bob that S exists and tells him what it points at — the
    // whole value of the id he was not supposed to have.
    expect(await mem.neighbors("S", { scopes: BOB })).toEqual([])
    expect(await mem.neighbors("O", { scopes: BOB })).toEqual([])
  })

  test("🔴 a path through a private hop is indistinguishable from no path", async () => {
    // G -> S -> O. Bob may see G, and O is reachable only THROUGH Alice's memory. Returning the path
    // would disclose that S exists and how it connects, which is most of what the id protected.
    expect(await mem.path("G", "O", 4, { scopes: BOB })).toBeNull()
  })

  test("one officer cannot walk into another officer's cabinet", async () => {
    expect(await mem.neighbors("G", { scopes: ["global", "agent:theron"] })).toEqual([])
  })
})

describe("a stranger cannot MUTATE across the boundary", () => {
  test("🔴 invalidating another chat's memory by id is REFUSED, loudly", async () => {
    const before = await mem.stats()
    // ⚠️ It used to RESOLVE — a refused erase reported as success, which is what let the `kb` tool
    // answer "Purged" about a row that is still here. The refusal is now named.
    await expect(mem.invalidate("S", undefined, { scopes: BOB })).rejects.toThrow(/refused to forget "S"/)
    const after = await mem.stats()
    expect(after.valid).toBe(before.valid)
  })

  test("🔴 purging another officer's memory by id is REFUSED, loudly — and the row survives", async () => {
    await expect(mem.purge("O", { scopes: BOB })).rejects.toThrow(/refused to purge "O"/)
    const rows = await mem.list({ includeInvalid: true, limit: 100 })
    expect(rows.some((m) => m.id === "O")).toBe(true)
  })
})

describe("…and the owner of a memory is not locked out of it", () => {
  test("Alice still reaches and forgets her own", async () => {
    // Alice reaches her own node's GLOBAL neighbours and not Lysander's (`S -> O`).
    //
    // ⚠️ `G` joined this list when `neighbors` became UNDIRECTED (the outgoing-only traversal made
    // every sink unreachable — see `neighbors-direction.test.ts`). It is not a leak and the expected
    // value is what changed, not the boundary: `G` is `global`, it is the node that points AT Alice's
    // memory, and both ends still have to clear the scope filter. The security claim is the NEGATIVE
    // one below, so it is asserted separately rather than left implicit in a list literal.
    const alice = (await mem.neighbors("S", { scopes: ALICE })).map((n) => n.id)
    expect([...alice].sort()).toEqual(["G", "G2"])
    expect(alice).not.toContain("O") // Lysander's cabinet stays invisible in BOTH directions
    const before = await mem.stats()
    await mem.invalidate("S_own", undefined, { scopes: ALICE })
    const after = await mem.stats()
    expect(after.valid).toBe(before.valid - 1)
  })

  test("Lysander still reaches his own cabinet from the shared node", async () => {
    expect((await mem.neighbors("G", { scopes: LYSANDER })).map((n) => n.id)).toEqual(["O"])
  })

  test("everyone still shares the global node", async () => {
    for (const scopes of [ALICE, BOB, LYSANDER]) {
      const rows = await mem.list({ scopes, limit: 100 })
      expect(rows.some((m) => m.id === "G")).toBe(true)
    }
  })

  test("⚠️ the OWNER surface still sees everything — the Memory app is not a chat", async () => {
    // `MemoryAccess.owner()` carries no scope filter. Confining the person's own Memory app to one
    // chat would be a different product; the point is that this reach is spelled, not reached by
    // leaving an argument out.
    expect(MemoryAccess.owner().scopes).toBeUndefined()
    const seen = await mem.neighbors("G")
    expect(seen.map((n) => n.id).sort()).toEqual(["O", "S"])
  })
})

/**
 * ⚠️ **What is LOAD-BEARING here, and what is not** — established by A/B, not by reading the code.
 *
 * Reverting the derivation reddened exactly ONE of these tests: the refusal of incompatible pairs.
 * The narrowing itself is currently UNOBSERVABLE through any traversal, because no query reads an
 * edge's own scope — `neighbors`, `path` and `graph` all filter on NODE scopes (`m`/`n`/`a`/`b`), and
 * given narrowest-derivation an edge's scope can never be narrower than both its endpoints anyway. So
 * an edge-scope check would be redundant rather than a second barrier, and claiming two would be
 * claiming a defence that does not exist.
 *
 * It is still worth deriving. Storing `global` on a relation between a shared memory and a private one
 * is a FALSE RECORD — the row says the relation is shared when it is not — and this whole programme is
 * about stored data that tells the truth. Writing it correctly now also means no migration if a
 * traversal ever does consult it, which is the cheaper order given that rows are dropped rather than
 * migrated.
 */
describe("a relation cannot PROMOTE visibility", () => {
  /** A fresh store per test — these write edges, and a shared one would couple them by order. */
  const withStore = async (body: (engine: WasmMemory) => Promise<void>) => {
    const d = mkdtempSync(join(tmpdir(), "kb-rel-"))
    const engine = await WasmMemory.open(join(d, "graph"), { dim: DIM })
    try {
      const add = (id: string, scope: string) => engine.addMemory({ id, kind: "entity", text: id, scope })
      await add("pub", "global")
      await add("pub2", "global")
      await add("mine", "session:alice")
      await add("theirs", "agent:lysander")
      await body(engine)
    } finally {
      await engine.close()
      rmSync(d, { recursive: true, force: true })
    }
  }

  test("shared joined to private is RECORDED at the private scope, whatever the caller asked for", async () => {
    // `scope: "global"` is what the `kb` tool passed for every relation. The stored row now says what
    // is true. ⚠️ The traversal assertions below hold because of the NODE checks, not this one — they
    // are here as the control proving the derivation broke nothing, not as evidence that it is what
    // stops Bob.
    await withStore(async (engine) => {
      const result = await engine.addEdge({ from: "pub", to: "mine", type: "r", scope: "global" })
      expect(result).toEqual({ ok: true, scope: "session:alice" })
      expect(await engine.neighbors("pub", { scopes: BOB })).toEqual([])
      expect((await engine.neighbors("pub", { scopes: ALICE })).map((n) => n.id)).toEqual(["mine"])
    })
  }, 60_000)

  test("direction does not matter — narrowest wins either way", async () => {
    await withStore(async (engine) => {
      expect(await engine.addEdge({ from: "mine", to: "pub", type: "r", scope: "global" })).toEqual({
        ok: true,
        scope: "session:alice",
      })
    })
  }, 60_000)

  test("🔴 two DIFFERENT private spaces are REFUSED, not narrowed", async () => {
    // No scope contains both, so any edge between them widens one. Refusing is the only honest answer.
    await withStore(async (engine) => {
      expect(await engine.addEdge({ from: "mine", to: "theirs", type: "r", scope: "global" })).toEqual({ ok: false })
      expect(await engine.neighbors("mine", { scopes: ALICE })).toEqual([])
    })
  }, 60_000)

  test("shared to shared stays shared", async () => {
    await withStore(async (engine) => {
      expect(await engine.addEdge({ from: "pub", to: "pub2", type: "r", scope: "global" })).toEqual({
        ok: true,
        scope: "global",
      })
    })
  }, 60_000)

  test("a restricted caller cannot relate to an endpoint it may not see", async () => {
    await withStore(async (engine) => {
      const result = await engine.addEdge({
        from: "pub",
        to: "theirs",
        type: "r",
        scope: "global",
        scopes: ["global", "session:alice"],
      })
      expect(result).toEqual({ ok: false })
    })
  }, 60_000)

  test("⚠️ a REFUSAL is reported, never silent — a quiet no-op teaches a model to trust a graph that is not there", async () => {
    await withStore(async (engine) => {
      expect((await engine.addEdge({ from: "pub", to: "nope", type: "r", scope: "global" })).ok).toBe(false)
    })
  }, 60_000)
})

describe("scope arithmetic", () => {
  test("an ordinary relation takes the NARROWEST endpoint, never the widest", () => {
    expect(MemoryAccess.narrowest("global", "session:alice")).toBe("session:alice")
    expect(MemoryAccess.narrowest("session:alice", "global")).toBe("session:alice")
    expect(MemoryAccess.narrowest("global", "global")).toBe("global")
  })

  test("two DIFFERENT private spaces are incompatible — no scope contains both", () => {
    expect(MemoryAccess.compatible("global", "session:alice")).toBe(true)
    expect(MemoryAccess.compatible("session:alice", "session:alice")).toBe(true)
    expect(MemoryAccess.compatible("session:alice", "agent:lysander")).toBe(false)
  })
})
