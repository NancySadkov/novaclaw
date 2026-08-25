import { describe, expect, test } from "bun:test"
import type { EdgeRow, MemoryRow } from "@/utils/memory-api"
import { hubLabel, isHub, projectGraph, type ProjectedNode } from "./project"

const row = (id: string, kind: string, scope = "global"): MemoryRow => ({
  id,
  kind,
  text: `${id} text`,
  name: kind === "entity" ? id : null,
  scope,
  source: null,
  confidence: null,
  relation: "about",
  status: "active",
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
})

/**
 * The ingestion shape, which is the one that made this necessary: a document stored as an ENTITY,
 * `n` passages hanging off it by `part_of`, and absorbed passages pointing at extracted entities.
 */
function ingested(passages: number, mentions: Record<number, string[]> = {}) {
  const nodes: MemoryRow[] = [row("doc", "entity")]
  const edges: EdgeRow[] = []
  const mentioned = new Set<string>()
  for (let i = 0; i < passages; i++) {
    const id = `p${i}`
    nodes.push(row(id, "passage"))
    edges.push({ from: id, to: "doc", type: "part_of" })
    for (const entity of mentions[i] ?? []) {
      if (!mentioned.has(entity)) {
        mentioned.add(entity)
        nodes.push(row(entity, "entity"))
      }
      edges.push({ from: id, to: entity, type: "mentions" })
    }
  }
  return { nodes, edges }
}

const noPassages = (kind: string) => kind !== "passage"
const everything = () => true
const hubs = (nodes: readonly ProjectedNode[]) => nodes.filter(isHub)
const ids = (nodes: readonly ProjectedNode[]) => nodes.map((n) => n.id).sort()

describe("projectGraph", () => {
  test("nothing hidden → the graph passes through untouched", () => {
    const { nodes, edges } = ingested(3, { 0: ["Dragon"] })
    const out = projectGraph(nodes, edges, everything)
    expect(out.hiddenCount).toBe(0)
    expect(out.nodes.length).toBe(nodes.length)
    expect(out.edges.length).toBe(edges.length)
    expect(hubs(out.nodes).length).toBe(0)
  })

  test("🔴 an extracted entity keeps its path to the document when passages are hidden", () => {
    // The regression: `Dragon` reached `doc` ONLY through `p0`. Hiding passages used to leave Dragon
    // floating unconnected beside a document hub with nothing attached to it.
    const { nodes, edges } = ingested(4, { 0: ["Dragon"], 2: ["Dragon"], 3: ["Castle"] })
    const out = projectGraph(nodes, edges, noPassages)
    const hub = hubs(out.nodes)[0]!
    expect(hub.count).toBe(4)
    expect(hub.anchor).toBe("doc")
    expect(hubLabel(hub)).toBe("4 passages")
    // Every visible mark is reachable from the document through the hub.
    expect(ids(out.nodes)).toEqual(["Castle", "Dragon", "doc", hub.id].sort())
    const links = out.edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort()
    expect(links).toEqual([`${hub.id}->Castle:mentions`, `${hub.id}->Dragon:mentions`, `${hub.id}->doc:part_of`].sort())
  })

  test("no entity-to-entity edge is EVER invented", () => {
    const { nodes, edges } = ingested(3, { 0: ["Dragon"] })
    const out = projectGraph(nodes, edges, noPassages)
    const entities = new Set(nodes.filter((n) => n.kind === "entity").map((n) => n.id))
    // Not one drawn edge joins two real entities — the bridge the cheap repair would have drawn.
    expect(out.edges.some((e) => entities.has(e.from) && entities.has(e.to))).toBe(false)
  })

  test("duplicate edges MERGE and carry their count", () => {
    const { nodes, edges } = ingested(5, { 0: ["Dragon"], 1: ["Dragon"], 4: ["Dragon"] })
    const out = projectGraph(nodes, edges, noPassages)
    const hub = hubs(out.nodes)[0]!
    expect(out.edges.find((e) => e.to === "doc")!.count).toBe(5)
    expect(out.edges.find((e) => e.to === "Dragon")!.count).toBe(3)
    expect(out.edges.filter((e) => e.from === hub.id).length).toBe(2)
  })

  test("the hub's own internal wiring is not drawn", () => {
    const nodes = [row("doc", "entity"), row("p0", "passage"), row("p1", "passage")]
    const edges: EdgeRow[] = [
      { from: "p0", to: "doc", type: "part_of" },
      { from: "p1", to: "doc", type: "part_of" },
      { from: "p0", to: "p1", type: "follows" },
    ]
    const out = projectGraph(nodes, edges, noPassages)
    // `p0 -follows-> p1` collapses to a self-loop on the hub; a graph reporting on its own
    // summarisation is noise.
    expect(out.edges.some((e) => e.from === e.to)).toBe(false)
    expect(out.edges.length).toBe(1)
  })

  test("two documents get two hubs, each beside its own", () => {
    const nodes = [row("a", "entity"), row("b", "entity"), row("pa", "passage"), row("pb", "passage")]
    const edges: EdgeRow[] = [
      { from: "pa", to: "a", type: "part_of" },
      { from: "pb", to: "b", type: "part_of" },
    ]
    const out = projectGraph(nodes, edges, noPassages)
    const anchors = hubs(out.nodes)
      .map((h) => h.anchor)
      .sort()
    expect(anchors).toEqual(["a", "b"])
  })

  test("a hub whose members disagree about scope claims NO scope", () => {
    const nodes = [row("doc", "entity"), row("p0", "passage", "global"), row("p1", "passage", "session:x")]
    const edges: EdgeRow[] = [
      { from: "p0", to: "doc", type: "part_of" },
      { from: "p1", to: "doc", type: "part_of" },
    ]
    const out = projectGraph(nodes, edges, noPassages)
    expect(hubs(out.nodes)[0]!.scope).toBeUndefined()

    const agreeing = projectGraph(
      [row("doc", "entity"), row("q0", "passage", "global"), row("q1", "passage", "global")],
      [
        { from: "q0", to: "doc", type: "part_of" },
        { from: "q1", to: "doc", type: "part_of" },
      ],
      noPassages,
    )
    expect(hubs(agreeing.nodes)[0]!.scope).toBe("global")
  })

  test("a hidden node with no container groups as loose, and still keeps its links", () => {
    const nodes = [row("Dragon", "entity"), row("p0", "passage")]
    const edges: EdgeRow[] = [{ from: "p0", to: "Dragon", type: "mentions" }]
    const out = projectGraph(nodes, edges, noPassages)
    const hub = hubs(out.nodes)[0]!
    expect(hub.anchor).toBeUndefined()
    expect(out.edges).toEqual([{ from: hub.id, to: "Dragon", type: "mentions", count: 1 }])
  })

  test("a hub nothing connects to is not drawn at all", () => {
    // Passages with no edges say nothing the header's hidden count does not already say.
    const out = projectGraph([row("doc", "entity"), row("p0", "passage")], [], noPassages)
    expect(hubs(out.nodes).length).toBe(0)
    expect(out.hiddenCount).toBe(1)
    expect(ids(out.nodes)).toEqual(["doc"])
  })

  test("hiddenCount counts MEMORIES, never hubs", () => {
    const { nodes, edges } = ingested(202, { 0: ["Dragon"] })
    const out = projectGraph(nodes, edges, noPassages)
    expect(out.hiddenCount).toBe(202)
    expect(hubs(out.nodes).length).toBe(1)
    expect(hubLabel(hubs(out.nodes)[0]!)).toBe("202 passages")
  })

  test("an edge into a hidden node whose kind is hidden AND uncontained still lands somewhere", () => {
    // Nothing may vanish silently: every stored edge either survives, merges, or is an internal loop.
    const { nodes, edges } = ingested(6, { 1: ["Dragon"], 5: ["Castle"] })
    const out = projectGraph(nodes, edges, noPassages)
    const surviving = out.edges.reduce((n, e) => n + e.count, 0)
    expect(surviving).toBe(edges.length)
  })
})
