import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planIngest } from "./ingest-plan"
import { WasmMemory } from "./wasm-engine"

/**
 * THE SEEDED FIXTURE — a real engine, written through the real ingest plan, read back through the
 * real `graph()`.
 *
 * 🔴 What this replaces and why. `packages/novaclaw/test/memory-ingest-graph.test.ts` proved its
 * properties by `readFileSync`-ing the handler and comparing `indexOf` positions — the *test that
 * checks itself*, which passes on source that reads correctly and says nothing about what reaches the
 * store. Every one of its three claims is a claim about the STORE, so the store is what to ask.
 *
 * 🔴 And the record says it plainly: four defects in this programme were found by running the app,
 * not by any test, and two more by A/B-ing tests that turned out to pass vacuously. Coordinate math
 * was green while the camera never fitted; the slice's unit tests were green while the biggest
 * document starved the older one, because every fixture in them was small enough to fit. **Scale and
 * reality were the missing variables**, so this file supplies both: the ledger's stated corpus — 300
 * passages, 20 entities, a disconnected memory, an old hub, a partial slice, two owner scopes —
 * against the engine that ships.
 *
 * Cost, measured: ~1.2 s to open, ~2.5 s to write 620 rows and edges, ~0.3 s per graph read.
 */

const DIM = 8
const OLD_DOC = "Old Handbook"
const NEW_DOC = "New Manual"
const OTHER_SCOPE = "agent:lysander"

let dir: string
let mem: WasmMemory

/** Apply a plan the way the ingest handler does — every step, in the plan's order. */
async function ingest(engine: WasmMemory, name: string, text: string, scope?: string) {
  const plan = planIngest({ name, text, ...(scope === undefined ? {} : { scope }) })
  for (const step of plan.steps) {
    if (step.kind === "memory") await engine.addMemory(step.input as never)
    else await engine.addEdge(step.input as never)
  }
  return plan
}

const paragraphs = (n: number, prefix: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      `${prefix} chapter ${i + 1}. The calibration procedure requires the operator to verify rotor ` +
      `alignment and then confirm the auxiliary dampener has settled within tolerance, recording ` +
      `readings at thirty second intervals until three consecutive samples agree.`,
  ).join("\n\n")

let oldPlan: Awaited<ReturnType<typeof ingest>>
let newPlan: Awaited<ReturnType<typeof ingest>>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-fixture-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })

  // OLDEST first, so "the newest crowd out the older hub" is a shape this store can express.
  oldPlan = await ingest(mem, OLD_DOC, paragraphs(6, "Volume One"))
  // Twenty entities of the kind conversational extraction writes — named, unlinked.
  for (let i = 0; i < 20; i++)
    await mem.addMemory({
      id: `ent_${i}`,
      kind: "entity",
      text: `Fact number ${i} about the workshop.`,
      name: `Thing ${i}`,
      scope: "global",
    })
  // One memory with no relationships at all.
  await mem.addMemory({ id: "lonely", kind: "episode", text: "Something happened once.", scope: "global" })
  // A memory belonging to somebody ELSE, for owner switching.
  await mem.addMemory({
    id: "other_owner",
    kind: "entity",
    text: "Only Lysander remembers this.",
    name: "Lysander's own",
    scope: OTHER_SCOPE,
  })
  // …then the big new document, newest of all.
  // ⚠️ PARAGRAPHS, not passages — the chunker merges them, so 300 paragraphs yielded 126 chunks and
  // the fixture quietly failed to reach the scale it claimed. The assertion below reads the PLAN's
  // own count rather than a number typed here, so the corpus can never drift from what it asserts.
  newPlan = await ingest(mem, NEW_DOC, paragraphs(900, "Volume Two"))
}, 120_000)

afterAll(async () => {
  await mem?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("ingestion, against the engine that ships", () => {
  test("the document lands as ONE entity, and every passage hangs off it", async () => {
    const graph = await mem.graph({ scopes: ["global"], limit: 5000 })
    const byID = new Map(graph.nodes.map((n) => [n.id, n]))
    const document = byID.get(oldPlan.document.id)
    expect(document?.kind).toBe("entity")
    expect(document?.name).toBe(OLD_DOC)

    const passageIDs = new Set(oldPlan.passages.map((p) => p.id))
    expect(passageIDs.size).toBeGreaterThan(1)
    for (const id of passageIDs) {
      expect(byID.get(id)?.kind).toBe("passage")
      // The endpoint rule, proven from the STORE: the edge exists and points passage -> document.
      const edge = graph.edges.find((e) => e.from === id && e.to === oldPlan.document.id)
      expect(edge?.type).toBe("part_of")
    }
  })

  test("🔴 a reversed edge would still 'connect' — so the DIRECTION is asserted, not the count", async () => {
    const graph = await mem.graph({ scopes: ["global"], limit: 5000 })
    const backwards = graph.edges.filter((e) => e.from === oldPlan.document.id && e.type === "part_of")
    expect(backwards).toEqual([])
  })

  test("one NAME is one node — a second id formula would re-fragment the graph", async () => {
    // Re-ingesting the same document under the same name must not mint a second entity: the id is
    // derived, and it is the same derivation conversational extraction uses.
    const again = planIngest({ name: OLD_DOC, text: "completely different text", scope: "global" })
    expect(again.document.id).toBe(oldPlan.document.id)
  })
})

describe("the graph slice, against the engine that ships", () => {
  test("the fixture is the scale the ledger asked for", async () => {
    const stats = await mem.stats()
    // The ledger's corpus: 300+ passages, 20 entities, an orphan, another owner's memory, two docs.
    expect(newPlan.passages.length).toBeGreaterThanOrEqual(300)
    expect(stats.valid).toBeGreaterThanOrEqual(newPlan.passages.length + oldPlan.passages.length + 24)
  })

  test("🔴 the OLD document survives a much larger newer one", async () => {
    // The defect twice over: first "newest wins", then "biggest wins". Both returned a store in which
    // the older document did not appear at all.
    const graph = await mem.graph({ scopes: ["global"], limit: 100 })
    const ids = new Set(graph.nodes.map((n) => n.id))
    expect(ids.has(oldPlan.document.id)).toBe(true)
    expect(ids.has(newPlan.document.id)).toBe(true)
  })

  test("a hub arrives WITH what makes it a hub", async () => {
    const graph = await mem.graph({ scopes: ["global"], limit: 100 })
    const ids = new Set(graph.nodes.map((n) => n.id))
    const attached = oldPlan.passages.filter((p) => ids.has(p.id))
    expect(attached.length).toBeGreaterThan(0)
    // Every returned edge has both endpoints present — the client is never handed a dangling one.
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })

  test("a partial slice SAYS it is partial, and its numbers add up", async () => {
    const graph = await mem.graph({ scopes: ["global"], limit: 100 })
    expect(graph.slice.partial).toBe(true)
    expect(graph.slice.reason).toBe("connected-first")
    expect(graph.slice.returned).toBe(graph.nodes.length)
    expect(graph.slice.returned + graph.slice.omitted).toBe(graph.slice.total)
  })

  test("a slice large enough to hold everything reports COMPLETE", async () => {
    const graph = await mem.graph({ scopes: ["global"], limit: 5000 })
    expect(graph.slice.partial).toBe(false)
    expect(graph.slice.reason).toBe("complete")
    expect(graph.slice.omitted).toBe(0)
  })

  test("the unconnected memory is reachable when the budget allows", async () => {
    const graph = await mem.graph({ scopes: ["global"], limit: 5000 })
    expect(graph.nodes.some((n) => n.id === "lonely")).toBe(true)
    expect(graph.edges.some((e) => e.from === "lonely" || e.to === "lonely")).toBe(false)
  })

  test("🔴 OWNER SWITCHING is a real boundary, not a filter on the way out", async () => {
    const mine = await mem.graph({ scopes: ["global"], limit: 5000 })
    expect(mine.nodes.some((n) => n.id === "other_owner")).toBe(false)

    const theirs = await mem.graph({ scopes: [OTHER_SCOPE], limit: 5000 })
    expect(theirs.nodes.map((n) => n.id)).toEqual(["other_owner"])
    // …and the totals are per-owner too, or the notice would quote somebody else's cabinet.
    expect(theirs.slice.total).toBe(1)
    expect(theirs.slice.partial).toBe(false)
  })

  test("a scope nobody uses returns an empty COMPLETE graph, never a partial one", async () => {
    const none = await mem.graph({ scopes: ["agent:nobody"], limit: 100 })
    expect(none.nodes).toEqual([])
    expect(none.slice).toEqual({ partial: false, total: 0, returned: 0, omitted: 0, reason: "complete" })
  })
})
