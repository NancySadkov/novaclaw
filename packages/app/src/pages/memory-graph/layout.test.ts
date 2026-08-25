import { describe, expect, test } from "bun:test"
import { layoutGraph } from "./layout"

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe("layoutGraph", () => {
  test("empty graph → empty positions", () => {
    expect(layoutGraph([], [])).toEqual({})
  })

  test("deterministic: same input → identical positions (the stable-layout crux)", () => {
    const ids = ["a", "b", "c", "d", "e"]
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]
    const one = layoutGraph(ids, edges)
    const two = layoutGraph(ids, edges)
    expect(two).toEqual(one)
  })

  test("every node gets a position inside the bounds", () => {
    const ids = ["a", "b", "c", "d"]
    const pos = layoutGraph(ids, [{ from: "a", to: "b" }], { width: 800, height: 600 })
    for (const id of ids) {
      expect(pos[id]).toBeDefined()
      expect(pos[id]!.x).toBeGreaterThanOrEqual(0)
      expect(pos[id]!.x).toBeLessThanOrEqual(800)
      expect(pos[id]!.y).toBeGreaterThanOrEqual(0)
      expect(pos[id]!.y).toBeLessThanOrEqual(600)
    }
  })

  test("connected nodes settle closer than unconnected ones", () => {
    // a-b-c is a chain; x,y,z are a separate chain. a and z share no edge and should end up farther
    // apart than the directly-connected a and b.
    const ids = ["a", "b", "c", "x", "y", "z"]
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "x", to: "y" },
      { from: "y", to: "z" },
    ]
    const pos = layoutGraph(ids, edges)
    expect(dist(pos.a!, pos.b!)).toBeLessThan(dist(pos.a!, pos.z!))
  })

  test("respects seeded positions for existing nodes (incremental stability)", () => {
    const seed = { a: { x: 100, y: 100 }, b: { x: 110, y: 110 } }
    // Zero iterations = no relaxation, so seeded nodes stay put and a new node gets its hash seed.
    const pos = layoutGraph(["a", "b", "c"], [], { seed, iterations: 0 })
    expect(pos.a).toEqual({ x: 100, y: 100 })
    expect(pos.b).toEqual({ x: 110, y: 110 })
    expect(pos.c).toBeDefined()
  })

  /**
   * How far OUT a point sits, per axis, normalised so the band is 1 — the larger of the two.
   *
   * ⚠️ Two drafts of these tests were wrong before this one, in opposite directions.
   * "Outside the linked nodes' bounding box" PASSED with the band disabled: repulsion flings a lone
   * node into a corner of the box the connected chain sits in the middle of, so it was true for the
   * wrong reason. Euclidean distance FAILED with the band enabled: the core box's own corner reaches
   * 0.93 of the band ellipse, so the two do not separate radially at all.
   *
   * They separate per AXIS, which is the actual geometry: the core is clamped to 0.62 of each axis
   * (so at most 0.62/2 / 0.47 = 0.66 here) and every point on the band has |cos| or |sin| ≥ 0.707.
   */
  const outwardness = (p: { x: number; y: number }, plane = { width: 1000, height: 700 }) =>
    Math.max(
      Math.abs((p.x - plane.width / 2) / (plane.width * 0.47)),
      Math.abs((p.y - plane.height / 2) / (plane.height * 0.47)),
    )

  test("🔴 an unlinked memory settles OUTSIDE the connected core, not inside it", () => {
    // The defect: gravity pulls an orphan to the centre like everything else, so it lands among the
    // connected nodes and reads as one of them — the map implying a relationship the store never held.
    const core = ["a", "b", "c"]
    const pos = layoutGraph([...core, "lonely"], [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ])
    expect(outwardness(pos.lonely!)).toBeGreaterThan(0.7)
    // …and the core cannot reach it: the connected nodes are confined inside 0.67 on BOTH axes.
    for (const id of core) expect(outwardness(pos[id]!)).toBeLessThan(0.67)
  })

  test("EVERY orphan is outside the core, at every angle of the band", () => {
    // The band is an ellipse and the core a box, so the separation has to hold on the short axis too —
    // a circular band would put the top and bottom orphans back inside a wide core.
    const orphans = Array.from({ length: 16 }, (_, i) => `o${i}`)
    const pos = layoutGraph(["a", "b", ...orphans], [{ from: "a", to: "b" }])
    for (const id of orphans) expect(outwardness(pos[id]!)).toBeGreaterThan(0.7)
    for (const id of ["a", "b"]) expect(outwardness(pos[id]!)).toBeLessThan(0.67)
  })

  test("the band is ordered by ID, so two loads of the same memories agree", () => {
    const edges = [{ from: "a", to: "b" }]
    const first = layoutGraph(["a", "b", "z", "m", "q"], edges)
    // Same memories, arriving in a different order from the server.
    const second = layoutGraph(["q", "b", "m", "a", "z"], edges)
    for (const id of ["m", "q", "z"]) expect(second[id]).toEqual(first[id]!)
    // Evenly spaced ON THE ELLIPSE: each sits at normalised radius 1.
    for (const id of ["m", "q", "z"]) {
      const dx = (first[id]!.x - 500) / (1000 * 0.47)
      const dy = (first[id]!.y - 350) / (700 * 0.47)
      expect(Math.hypot(dx, dy)).toBeCloseTo(1, 6)
    }
  })

  test("⚠️ the band OVERRIDES a cached position — a stale orphan seed is an old accident", () => {
    const pos = layoutGraph(["a", "b", "stray"], [{ from: "a", to: "b" }], {
      seed: { stray: { x: 501, y: 351 } },
      iterations: 0,
    })
    // Seeded a pixel from the centre; it must not stay there.
    expect(dist(pos.stray!, { x: 500, y: 350 })).toBeGreaterThan(100)
  })

  test("NO edges means no band — there is no core to be outside of", () => {
    // Also the case that keeps incremental stability working: with nothing linked, seeds still win.
    const seed = { a: { x: 100, y: 100 }, b: { x: 110, y: 110 } }
    const pos = layoutGraph(["a", "b"], [], { seed, iterations: 0 })
    expect(pos.a).toEqual({ x: 100, y: 100 })
    expect(pos.b).toEqual({ x: 110, y: 110 })
  })

  test("a banded node stays inside the plane", () => {
    const ids = ["a", "b", ...Array.from({ length: 12 }, (_, i) => `o${i}`)]
    const pos = layoutGraph(ids, [{ from: "a", to: "b" }], { width: 400, height: 300 })
    for (const id of ids) {
      expect(pos[id]!.x).toBeGreaterThanOrEqual(0)
      expect(pos[id]!.x).toBeLessThanOrEqual(400)
      expect(pos[id]!.y).toBeGreaterThanOrEqual(0)
      expect(pos[id]!.y).toBeLessThanOrEqual(300)
    }
  })

  test("tolerates dangling edges (endpoint not in the node set)", () => {
    const pos = layoutGraph(
      ["a", "b"],
      [
        { from: "a", to: "ghost" },
        { from: "a", to: "b" },
      ],
    )
    expect(pos.a).toBeDefined()
    expect(pos.b).toBeDefined()
    expect(pos.ghost).toBeUndefined()
  })
})
