import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WasmMemory } from "./wasm-engine"

/**
 * 🔴 **`neighbors` matched only OUTGOING edges, which made it useless on every real store.**
 *
 * The claim lifecycle points `subject` edges claim→entity, so an entity — the thing a question is
 * ABOUT, and therefore the thing a traversal starts from — is a pure SINK. It has no outgoing edges
 * at all, so `neighbors(entity)` returned an empty list on a correctly ingested document.
 *
 * **Measured on the board-game corpus, 2026-08-26**, and this is why the fix is not cosmetic:
 *
 * | retrieval | gold answer found |
 * |---|---|
 * | passages only, edges OFF | 4/40 (10%) |
 * | edges ON, walking `graph()`'s edge list | **18/40 (45%)**, noise floor 0–3% |
 * | the same walk restricted to OUTGOING edges (what `neighbors` did) | **0/40 — nothing, ever** |
 *
 * So the entire 45% the graph is worth was unreachable through the shipped accessor. The ablation
 * runner only measured the benefit because it bypassed `neighbors` and walked the edge list itself.
 *
 * ⚠️ **Direction is a STORAGE detail; adjacency is the question.** A caller asking "what is next to
 * this node" is not asking which way an ingest happened to write the arrow, so the traversal is
 * undirected and the edge `type` still says what the relation was.
 */

const DIM = 4
const SCOPE = "global"

let dir: string
let mem: WasmMemory

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nc-neighbors-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
  // The shape the lifecycle actually writes: a CLAIM points AT the entity it is about.
  await mem.addMemory({ id: "claim-1", kind: "claim", text: "Ticket to Ride plays 2-5 players.", scope: SCOPE })
  await mem.addMemory({ id: "entity-1", kind: "entity", text: "Ticket to Ride", name: "Ticket to Ride", scope: SCOPE })
  const edge = await mem.addEdge({ from: "claim-1", to: "entity-1", type: "subject", scope: SCOPE })
  expect(edge.ok).toBe(true) // a refused edge would make every assertion below vacuously pass
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("neighbors is UNDIRECTED — an entity is a sink, and a sink is what questions start from", () => {
  test("control: the direction that always worked still works", async () => {
    const out = await mem.neighbors("claim-1")
    expect(out.map((n) => n.id)).toEqual(["entity-1"])
    expect(out[0]!.type).toBe("subject")
  })

  // 🔴 THE DEFECT. Before the fix this returned [] — on a real corpus, 0/40 forever.
  test("the entity reaches the claim that is ABOUT it", async () => {
    const back = await mem.neighbors("entity-1")
    expect(back.map((n) => n.id)).toEqual(["claim-1"])
  })

  test("the relation type survives the incoming hop — adjacency is not anonymised", async () => {
    const back = await mem.neighbors("entity-1")
    expect(back[0]!.type).toBe("subject")
  })

  test("text comes back hydrated in BOTH directions, not just the outgoing one", async () => {
    // The hydrate-by-key step runs after the traversal; an incoming hop must not skip it.
    expect((await mem.neighbors("entity-1"))[0]!.text).toContain("2-5 players")
    expect((await mem.neighbors("claim-1"))[0]!.text).toContain("Ticket to Ride")
  })

  test("an isolated node still has no neighbours — the fix must not invent adjacency", async () => {
    await mem.addMemory({ id: "lonely", kind: "entity", text: "Unconnected", scope: SCOPE })
    expect(await mem.neighbors("lonely")).toEqual([])
  })
})
