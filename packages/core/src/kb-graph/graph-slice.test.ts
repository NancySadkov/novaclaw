import { describe, expect, test } from "bun:test"
import { RECENCY_SHARE, selectSlice, type SliceEdge, type SliceNode } from "./graph-slice"

const node = (id: string, kind = "entity"): SliceNode => ({ id, kind })

/**
 * The shape that produced the defect: an old, well-connected document and every one of its passages
 * written in one burst AFTER it, so "the newest N" is that burst and nothing else.
 *
 * Returned newest-first, matching the store's `ORDER BY t_created DESC` scan.
 */
function ingestedOverOldEntities(passages: number, oldEntities: number) {
  const nodes: SliceNode[] = []
  const edges: SliceEdge[] = []
  for (let i = passages - 1; i >= 0; i--) {
    nodes.push(node(`p${i}`, "passage"))
    edges.push({ from: `p${i}`, to: "doc" })
  }
  nodes.push(node("doc"))
  for (let i = 0; i < oldEntities; i++) nodes.push(node(`old${i}`))
  return { nodes, edges }
}

describe("selectSlice", () => {
  test("everything fits → everything is returned, and it says so", () => {
    const { nodes, edges } = ingestedOverOldEntities(5, 2)
    const out = selectSlice(nodes, edges, { limit: 100, total: nodes.length })
    expect(out.ids.length).toBe(nodes.length)
    expect(out.meta).toEqual({
      partial: false,
      total: nodes.length,
      returned: nodes.length,
      omitted: 0,
      reason: "complete",
    })
  })

  test("🔴 an ingested document does not push the older hub off the end", () => {
    // The regression, stated as the assertion. `doc` is the single most connected node and the
    // OLDEST-but-one; taking the newest 40 rows returns forty passages and nothing else.
    const { nodes, edges } = ingestedOverOldEntities(300, 6)
    const out = selectSlice(nodes, edges, { limit: 40, total: nodes.length })
    expect(out.ids).toContain("doc")
    expect(out.meta.partial).toBe(true)
    expect(out.meta.reason).toBe("connected-first")
    expect(out.meta.total).toBe(307)
    expect(out.meta.returned).toBe(40)
    expect(out.meta.omitted).toBe(267)
  })

  test("a hub arrives WITH the things that make it a hub", () => {
    const { nodes, edges } = ingestedOverOldEntities(300, 6)
    const out = selectSlice(nodes, edges, { limit: 40, total: nodes.length })
    const chosen = new Set(out.ids)
    // Every drawn edge needs both endpoints; a hub whose neighbours were all dropped is a lone mark.
    const survivingEdges = edges.filter((e) => chosen.has(e.from) && chosen.has(e.to))
    expect(survivingEdges.length).toBeGreaterThan(20)
  })

  test("⚠️ structure does not starve RECENCY — the newest memory is always reachable", () => {
    // The mirror-image failure: rank purely by connectivity and one old cluster owns the screen
    // forever. `fresh` is the newest row and has no edges at all.
    const { nodes, edges } = ingestedOverOldEntities(300, 6)
    const withFresh = [node("fresh"), ...nodes]
    const out = selectSlice(withFresh, edges, { limit: 40, total: withFresh.length })
    expect(out.ids).toContain("fresh")
  })

  test("the recency share is honoured, not merely non-zero", () => {
    const { nodes, edges } = ingestedOverOldEntities(300, 6)
    const limit = 40
    const out = selectSlice(nodes, edges, { limit, total: nodes.length })
    const newest = new Set(nodes.slice(0, Math.round(limit * RECENCY_SHARE)).map((n) => n.id))
    const kept = out.ids.filter((id) => newest.has(id))
    expect(kept.length).toBe(newest.size)
  })

  test("never exceeds the limit, and never repeats an id", () => {
    const { nodes, edges } = ingestedOverOldEntities(300, 6)
    for (const limit of [1, 2, 7, 40, 306]) {
      const out = selectSlice(nodes, edges, { limit, total: nodes.length })
      expect(out.ids.length).toBeLessThanOrEqual(limit)
      expect(new Set(out.ids).size).toBe(out.ids.length)
    }
  })

  test("deterministic: the same store yields the same slice", () => {
    const { nodes, edges } = ingestedOverOldEntities(120, 4)
    expect(selectSlice(nodes, edges, { limit: 30, total: 124 }).ids).toEqual(
      selectSlice(nodes, edges, { limit: 30, total: 124 }).ids,
    )
  })

  test("🔴 a SMALL OLD document survives a huge new one — the live shape, at live scale", () => {
    // Measured against a real store on 2026-08-25 and it FAILED: an old 5-node document and a newly
    // ingested 701-node one, budget 600, returned the new document plus 599 of its passages and NOT
    // ONE node of the old one. A single breadth-first walk drains its component before reaching the
    // second root, so "the newest crowd out the older hub" had merely become "the biggest crowds out
    // the older hub". Every earlier test in this file passed throughout, because in all of them both
    // components fit inside the budget — scale was the variable, not shape.
    const nodes: SliceNode[] = []
    const edges: SliceEdge[] = []
    // Newest first: the big new document and its 700 passages.
    for (let i = 0; i < 700; i++) {
      nodes.push(node(`new-p${i}`, "passage"))
      edges.push({ from: `new-p${i}`, to: "new-doc" })
    }
    nodes.push(node("new-doc"))
    // Then the old one, oldest of all.
    for (let i = 0; i < 4; i++) {
      nodes.push(node(`old-p${i}`, "passage"))
      edges.push({ from: `old-p${i}`, to: "old-doc" })
    }
    nodes.push(node("old-doc"))

    const out = selectSlice(nodes, edges, { limit: 600, total: nodes.length })
    expect(out.ids).toContain("old-doc")
    // And WITH its passages, or the old document is a lone mark whose edges point nowhere.
    const kept = out.ids.filter((id) => id.startsWith("old-p"))
    expect(kept.length).toBe(4)
    // The new document is still there too — this must not fix one starvation by creating another.
    expect(out.ids).toContain("new-doc")
    expect(out.ids.length).toBe(600)
  })

  test("a dozen documents all appear, not one document and its leaves", () => {
    const nodes: SliceNode[] = []
    const edges: SliceEdge[] = []
    for (let d = 0; d < 12; d++) {
      for (let i = 0; i < 200; i++) {
        nodes.push(node(`d${d}-p${i}`, "passage"))
        edges.push({ from: `d${d}-p${i}`, to: `d${d}` })
      }
      nodes.push(node(`d${d}`))
    }
    const out = selectSlice(nodes, edges, { limit: 300, total: nodes.length })
    const docs = out.ids.filter((id) => /^d\d+$/.test(id))
    expect(docs.length).toBe(12)
  })

  test("several components are all represented, best-connected first", () => {
    // Two clusters and a lone node. A slice that only ever walks one component would answer
    // "how does it connect" with one answer.
    const nodes = [node("a1"), node("a2"), node("a3"), node("b1"), node("b2"), node("lone")]
    const edges: SliceEdge[] = [
      { from: "a1", to: "a2" },
      { from: "a2", to: "a3" },
      { from: "a1", to: "a3" },
      { from: "b1", to: "b2" },
    ]
    const out = selectSlice(nodes, edges, { limit: 5, total: 6 })
    expect(out.ids).toContain("a1")
    expect(out.ids.some((id) => id.startsWith("b"))).toBe(true)
  })

  test("DEGREE counts distinct neighbours, so a chatty edge type cannot buy rank", () => {
    // `loud` has three stored relations to ONE memory; `wide` touches two. `wide` is the real hub.
    const nodes = [node("loud"), node("x"), node("wide"), node("y"), node("z")]
    const edges: SliceEdge[] = [
      { from: "loud", to: "x" },
      { from: "loud", to: "x" },
      { from: "loud", to: "x" },
      { from: "wide", to: "y" },
      { from: "wide", to: "z" },
    ]
    const out = selectSlice(nodes, edges, { limit: 2, total: 5 })
    // limit 2 → 1 structural + 1 recency slot; the structural slot must be the genuinely wider node.
    expect(out.ids).toContain("wide")
  })

  test("a self-edge is not connectivity", () => {
    const nodes = [node("selfy"), node("a"), node("b")]
    const edges: SliceEdge[] = [
      { from: "selfy", to: "selfy" },
      { from: "a", to: "b" },
    ]
    const out = selectSlice(nodes, edges, { limit: 2, total: 3 })
    expect(out.ids).toContain("a")
  })

  test("an edge to something the scan never saw is ignored", () => {
    const nodes = [node("a"), node("b"), node("c")]
    const edges: SliceEdge[] = [
      { from: "a", to: "ghost" },
      { from: "b", to: "c" },
    ]
    // `a` looks connected but its partner is not on offer; `b`/`c` are the real structure.
    const out = selectSlice(nodes, edges, { limit: 2, total: 3 })
    expect(out.ids).toContain("b")
  })

  test("a capped SCAN is partial even when what it read fits", () => {
    // The honest worst case: the store holds more rows than one scan will read, so `total` itself
    // describes more than was considered. Saying "complete" here would be the confident falsehood.
    const nodes = [node("a"), node("b")]
    const out = selectSlice(nodes, [], { limit: 100, total: 2, scanCapped: true })
    expect(out.meta.partial).toBe(true)
    expect(out.meta.reason).toBe("scan-capped")
  })

  test("a store larger than the scan reports the omission it can see", () => {
    const nodes = [node("a"), node("b")]
    const out = selectSlice(nodes, [], { limit: 100, total: 900 })
    expect(out.meta.partial).toBe(true)
    expect(out.meta.omitted).toBe(898)
  })

  test("no nodes → an empty, complete slice rather than a throw", () => {
    const out = selectSlice([], [], { limit: 50, total: 0 })
    expect(out.ids).toEqual([])
    expect(out.meta.partial).toBe(false)
    expect(out.meta.reason).toBe("complete")
  })
})
