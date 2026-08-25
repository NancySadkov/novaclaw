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
  test("🔴 invalidating another chat's memory by id does nothing", async () => {
    const before = await mem.stats()
    await mem.invalidate("S", undefined, { scopes: BOB })
    const after = await mem.stats()
    expect(after.valid).toBe(before.valid)
  })

  test("🔴 purging another officer's memory by id does nothing — it destroys history too", async () => {
    await mem.purge("O", { scopes: BOB })
    const rows = await mem.list({ includeInvalid: true, limit: 100 })
    expect(rows.some((m) => m.id === "O")).toBe(true)
  })
})

describe("…and the owner of a memory is not locked out of it", () => {
  test("Alice still reaches and forgets her own", async () => {
    // Alice reaches her own node's GLOBAL neighbour (`S -> G2`) and not Lysander's (`S -> O`).
    expect((await mem.neighbors("S", { scopes: ALICE })).map((n) => n.id)).toEqual(["G2"])
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
    expect(MemoryAccess.isUnrestricted(MemoryAccess.owner())).toBe(true)
    const seen = await mem.neighbors("G")
    expect(seen.map((n) => n.id).sort()).toEqual(["O", "S"])
  })
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

  test("an EMPTY restricted access admits nothing, and is not confused with unrestricted", () => {
    const none = MemoryAccess.of([])
    expect(MemoryAccess.isUnrestricted(none)).toBe(false)
    expect(MemoryAccess.admits(none, "global")).toBe(false)
    expect(MemoryAccess.admits(MemoryAccess.owner(), "agent:anyone")).toBe(true)
  })
})
