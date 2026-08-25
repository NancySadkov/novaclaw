import { describe, expect, test } from "bun:test"
import { nearestNeighborDistance, placeLabels, Priority, type LabelCandidate } from "./labels"

const VIEWPORT = { width: 800, height: 600 }

const candidate = (id: string, x: number, y: number, priority: Priority = Priority.Ordinary): LabelCandidate => ({
  id,
  text: id,
  x,
  y,
  priority,
})

describe("placeLabels", () => {
  test("well-separated marks all keep their labels", () => {
    const marks = [candidate("a", 20, 20), candidate("b", 20, 200), candidate("c", 20, 400)]
    expect(placeLabels(marks, { viewport: VIEWPORT }).size).toBe(3)
  })

  test("🔴 stacked marks do NOT pile up their text", () => {
    // Five marks within a few pixels: the old rule drew all five on top of each other whenever the
    // graph was under forty nodes, which is the state the complaint about unreadable labels described.
    const marks = [0, 1, 2, 3, 4].map((i) => candidate(`n${i}`, 100, 100 + i))
    expect(placeLabels(marks, { viewport: VIEWPORT }).size).toBe(1)
  })

  test("priority decides the survivor, not iteration order", () => {
    const low = candidate("aaa", 100, 100, Priority.Ordinary)
    const high = candidate("zzz", 100, 102, Priority.Selected)
    const forward = placeLabels([low, high], { viewport: VIEWPORT })
    const reversed = placeLabels([high, low], { viewport: VIEWPORT })
    expect([...forward]).toEqual(["zzz"])
    expect([...reversed]).toEqual(["zzz"])
  })

  test("equal priority breaks on id, so a redraw never swaps which one is readable", () => {
    const a = candidate("alpha", 100, 100)
    const b = candidate("beta", 100, 102)
    expect([...placeLabels([b, a], { viewport: VIEWPORT })]).toEqual(["alpha"])
    expect([...placeLabels([a, b], { viewport: VIEWPORT })]).toEqual(["alpha"])
  })

  test("the full priority ladder is honoured under crowding", () => {
    const stack: LabelCandidate[] = [
      { id: "ordinary", text: "ordinary", x: 300, y: 300, priority: Priority.Ordinary },
      { id: "isolated", text: "isolated", x: 300, y: 301, priority: Priority.Isolated },
      { id: "hub", text: "hub", x: 300, y: 302, priority: Priority.Hub },
      { id: "neighbor", text: "neighbor", x: 300, y: 303, priority: Priority.Neighbor },
      { id: "selected", text: "selected", x: 300, y: 304, priority: Priority.Selected },
    ]
    expect([...placeLabels(stack, { viewport: VIEWPORT })]).toEqual(["selected"])
  })

  test("a label that would run off the edge is dropped rather than clipped", () => {
    const offRight = { id: "x", text: "a very long memory label indeed", x: 780, y: 300, priority: Priority.Selected }
    const offBottom = { id: "y", text: "y", x: 100, y: 599, priority: Priority.Selected }
    const inside = candidate("ok", 100, 300)
    const drawn = placeLabels([offRight, offBottom, inside], { viewport: VIEWPORT })
    expect(drawn.has("x")).toBe(false)
    expect(drawn.has("y")).toBe(false)
    expect(drawn.has("ok")).toBe(true)
  })

  test("a label's WIDTH is what crowds its neighbour out, not merely its presence", () => {
    // `right` sits 100px to the right. A two-character label beside `left` never reaches it; a
    // twenty-six-character one runs straight through it.
    const pair = (text: string) => [
      { id: "left", text, x: 100, y: 300, priority: Priority.Selected },
      { id: "right", text: "right", x: 200, y: 300, priority: Priority.Ordinary },
    ]
    expect(placeLabels(pair("nm"), { viewport: VIEWPORT }).size).toBe(2)
    expect(placeLabels(pair("a considerably longer name"), { viewport: VIEWPORT }).has("right")).toBe(false)
  })

  test("no candidates → nothing drawn, and no throw", () => {
    expect(placeLabels([], { viewport: VIEWPORT }).size).toBe(0)
  })

  test("a zero-sized viewport draws nothing rather than everything", () => {
    // The unmeasured-canvas case. Drawing every label into a 0x0 box would be the same class of bug
    // the camera work fixed: acting on a measurement that was never taken.
    expect(placeLabels([candidate("a", 10, 10)], { viewport: { width: 0, height: 0 } }).size).toBe(0)
  })
})

describe("nearestNeighborDistance", () => {
  test("a lone point has no neighbour", () => {
    expect(nearestNeighborDistance([{ x: 5, y: 5 }], 0)).toBe(Infinity)
  })

  test("it finds the closest, not the first", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 3, y: 4 },
    ]
    expect(nearestNeighborDistance(points, 0)).toBe(5)
  })

  test("an out-of-range index is Infinity rather than a crash", () => {
    expect(nearestNeighborDistance([{ x: 0, y: 0 }], 7)).toBe(Infinity)
  })
})
