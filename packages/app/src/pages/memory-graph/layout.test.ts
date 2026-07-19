import { describe, expect, test } from "bun:test"
import { layoutGraph } from "./layout"

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe("layoutGraph", () => {
  test("empty graph → empty positions", () => {
    expect(layoutGraph([], [])).toEqual({})
  })

  test("deterministic: same input → identical positions (the stable-layout crux)", () => {
    const ids = ["a", "b", "c", "d", "e"]
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }]
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

  test("tolerates dangling edges (endpoint not in the node set)", () => {
    const pos = layoutGraph(["a", "b"], [{ from: "a", to: "ghost" }, { from: "a", to: "b" }])
    expect(pos.a).toBeDefined()
    expect(pos.b).toBeDefined()
    expect(pos.ghost).toBeUndefined()
  })
})
