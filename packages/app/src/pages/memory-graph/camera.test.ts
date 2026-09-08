import { describe, expect, test } from "bun:test"
import { centerOn, contentBounds, fitView, IDENTITY, isVisible, MAX_FIT_SCALE, project } from "./camera"

/**
 * The camera's whole job is that every mark the viewer draws is inside the box the user has. So these
 * assert the RESULT — a projected point inside the viewport — rather than the intermediate numbers.
 * A test that checks the formula it was written from proves the formula was typed twice.
 */
const PLANE = [
  { x: 0, y: 0 },
  { x: 1000, y: 700 },
  { x: 500, y: 350 },
]

const allInside = (points: readonly { x: number; y: number }[], view: ReturnType<typeof fitView>, port: { width: number; height: number }) =>
  points.every((p) => {
    const s = project(p, view)
    return s.x >= 0 && s.y >= 0 && s.x <= port.width && s.y <= port.height
  })

describe("contentBounds", () => {
  test("no points → no bounds (the empty graph has nothing to fit)", () => {
    expect(contentBounds([])).toBeUndefined()
  })

  test("the box encloses every point", () => {
    expect(contentBounds(PLANE)).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 700 })
  })
})

describe("fitView", () => {
  test("a window NARROWER than the plane still shows every node", () => {
    // 420x300 is a docked side pane. At the old fixed scale 1, x=1000 landed 580px off the right edge.
    const port = { width: 420, height: 300 }
    const view = fitView(contentBounds(PLANE), port)
    expect(view.scale).toBeLessThan(1)
    expect(allInside(PLANE, view, port)).toBe(true)
  })

  test("a window LARGER than the plane centres it instead of magnifying", () => {
    const port = { width: 2400, height: 1400 }
    const view = fitView(contentBounds(PLANE), port)
    expect(view.scale).toBe(MAX_FIT_SCALE)
    // Centred: the plane's midpoint lands on the viewport's midpoint.
    const mid = project({ x: 500, y: 350 }, view)
    expect(mid.x).toBeCloseTo(1200, 6)
    expect(mid.y).toBeCloseTo(700, 6)
  })

  test("a single node is centred, not blown up", () => {
    const port = { width: 800, height: 600 }
    const view = fitView(contentBounds([{ x: 900, y: 40 }]), port)
    expect(view.scale).toBe(MAX_FIT_SCALE)
    expect(project({ x: 900, y: 40 }, view)).toEqual({ x: 400, y: 300 })
  })

  test("padding is kept clear at the fitted scale", () => {
    const port = { width: 500, height: 500 }
    const view = fitView(contentBounds(PLANE), port, { padding: 60 })
    for (const p of PLANE) {
      const s = project(p, view)
      expect(s.x).toBeGreaterThanOrEqual(60 - 1e-6)
      expect(s.x).toBeLessThanOrEqual(port.width - 60 + 1e-6)
    }
  })

  test("an unmeasured viewport yields the identity, never NaN", () => {
    expect(fitView(contentBounds(PLANE), { width: 0, height: 0 })).toEqual(IDENTITY)
    expect(fitView(undefined, { width: 800, height: 600 })).toEqual(IDENTITY)
  })

  test("a viewport smaller than its own padding still produces a usable scale", () => {
    const view = fitView(contentBounds(PLANE), { width: 40, height: 30 }, { padding: 48 })
    expect(Number.isFinite(view.scale)).toBe(true)
    expect(view.scale).toBeGreaterThan(0)
  })
})

describe("isVisible / centerOn", () => {
  const port = { width: 800, height: 600 }

  test("a node dragged off the edge reads as not visible", () => {
    const view = { tx: -2000, ty: 0, scale: 1 }
    expect(isVisible({ x: 500, y: 300 }, view, port)).toBe(false)
  })

  test("centreOn brings it back WITHOUT changing the zoom the user chose", () => {
    const view = { tx: -2000, ty: 0, scale: 2.5 }
    const next = centerOn({ x: 500, y: 300 }, view, port)
    expect(next.scale).toBe(2.5)
    expect(project({ x: 500, y: 300 }, next)).toEqual({ x: 400, y: 300 })
    expect(isVisible({ x: 500, y: 300 }, next, port)).toBe(true)
  })
})
