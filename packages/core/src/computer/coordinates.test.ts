import { describe, expect, test } from "bun:test"
import { ComputerCoordinates as CC } from "./coordinates"

// The anchor for this whole file is a REAL measurement, not an invented example. On 2026-08-06 a
// synthetic 1280x800 dialog was drawn with exact button rects and sent to holo3.1; the model's
// replies and the true boxes are reproduced here so the conversion is pinned to observed behaviour
// rather than to my arithmetic. The full table is reproduced in `coordinates.ts`'s module note.
const VIEWPORT = { width: 1280, height: 800 }

const TARGETS = [
  { name: "Delete project", model: { x: 200, y: 720 }, box: { x1: 180, y1: 560, x2: 350, y2: 604 } },
  { name: "Cancel", model: { x: 679, y: 726 }, box: { x1: 800, y1: 560, x2: 940, y2: 604 } },
  { name: "Save changes", model: { x: 814, y: 726 }, box: { x1: 960, y1: 560, x2: 1120, y2: 604 } },
  { name: "Workspace name field", model: { x: 374, y: 324 }, box: { x1: 180, y1: 242, x2: 780, y2: 282 } },
] as const

const unwrap = (c: CC.Conversion) => {
  if (!c.ok) throw new Error(`expected ok, got ${JSON.stringify(c.error)}`)
  return c.point
}

describe("normalized-1000 -> pixels, against measured grounding output", () => {
  for (const t of TARGETS) {
    test(`${t.name} lands inside its true box`, () => {
      const px = unwrap(CC.toPixels(t.model, "normalized-1000", VIEWPORT))
      expect(CC.withinBox(px, t.box)).toBe(true)
    })
  }

  test("the seam run and the raw run agree to within a few pixels", () => {
    // Same target, two transports: a bespoke fetch returned (814,726), the same probe driven through
    // NovaClaw's own FileAttachment path returned (810,727). If the conversion ever drifts, these
    // stop agreeing before anything user-visible breaks.
    const raw = unwrap(CC.toPixels({ x: 814, y: 726 }, "normalized-1000", VIEWPORT))
    const seam = unwrap(CC.toPixels({ x: 810, y: 727 }, "normalized-1000", VIEWPORT))
    expect(raw).toEqual({ x: 1042, y: 581 })
    expect(seam).toEqual({ x: 1037, y: 582 })
    expect(Math.abs(raw.x - seam.x)).toBeLessThanOrEqual(6)
    expect(Math.abs(raw.y - seam.y)).toBeLessThanOrEqual(6)
  })
})

describe("the silent failure this module exists to prevent", () => {
  test("reading a normalized point AS pixels misses every target, without erroring", () => {
    // This is the bug, demonstrated rather than described: no exception, no out-of-range, just a
    // plausible point in the upper-left that hits nothing. It is why the space is declared per model
    // and never inferred at the click site.
    for (const t of TARGETS) {
      const asPixels = unwrap(CC.toPixels(t.model, "pixels", VIEWPORT))
      expect(CC.withinBox(asPixels, t.box)).toBe(false)
    }
  })

  test("every mis-read point stays on-screen, so nothing downstream can notice", () => {
    for (const t of TARGETS) {
      const asPixels = unwrap(CC.toPixels(t.model, "pixels", VIEWPORT))
      expect(asPixels.x).toBeGreaterThanOrEqual(0)
      expect(asPixels.x).toBeLessThanOrEqual(VIEWPORT.width)
      expect(asPixels.y).toBeGreaterThanOrEqual(0)
      expect(asPixels.y).toBeLessThanOrEqual(VIEWPORT.height)
    }
  })
})

describe("out of range is reported, never clamped", () => {
  test("a pixel-valued point declared as normalized-1000 is caught, and names the space that fits", () => {
    const out = CC.toPixels({ x: 1042, y: 581 }, "normalized-1000", VIEWPORT)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.kind).toBe("out-of-range")
    if (out.error.kind !== "out-of-range") return
    expect(out.error.axis).toBe("x")
    expect(out.error.max).toBe(1000)
    expect(out.error.alsoValidAs).toContain("pixels")
  })

  test("a point past the viewport in pixel space is rejected rather than pulled to the edge", () => {
    const out = CC.toPixels({ x: 1400, y: 10 }, "pixels", VIEWPORT)
    expect(out.ok).toBe(false)
    if (out.ok || out.error.kind !== "out-of-range") return
    expect(out.error.max).toBe(1280)
  })

  test("negative coordinates are rejected on both axes", () => {
    expect(CC.toPixels({ x: -1, y: 10 }, "pixels", VIEWPORT).ok).toBe(false)
    expect(CC.toPixels({ x: 10, y: -1 }, "pixels", VIEWPORT).ok).toBe(false)
  })
})

describe("spaces and edges", () => {
  test("normalized-1 scales the same way", () => {
    expect(unwrap(CC.toPixels({ x: 0.5, y: 0.5 }, "normalized-1", VIEWPORT))).toEqual({ x: 640, y: 400 })
  })

  test("pixels passes through, rounding to a whole pixel", () => {
    expect(unwrap(CC.toPixels({ x: 100.4, y: 200.6 }, "pixels", VIEWPORT))).toEqual({ x: 100, y: 201 })
  })

  test("the extremes of a normalized space map to the viewport corners", () => {
    expect(unwrap(CC.toPixels({ x: 0, y: 0 }, "normalized-1000", VIEWPORT))).toEqual({ x: 0, y: 0 })
    expect(unwrap(CC.toPixels({ x: 1000, y: 1000 }, "normalized-1000", VIEWPORT))).toEqual({ x: 1280, y: 800 })
  })

  test("a non-square viewport scales each axis independently", () => {
    // The normalized box is square while the screen is not, so a diagonal is NOT preserved --
    // asserting it here stops anyone "fixing" this into an aspect-preserving fit.
    const px = unwrap(CC.toPixels({ x: 500, y: 500 }, "normalized-1000", { width: 1920, height: 1080 }))
    expect(px).toEqual({ x: 960, y: 540 })
  })

  test("a degenerate viewport is an error, not a division by zero", () => {
    const out = CC.toPixels({ x: 500, y: 500 }, "normalized-1000", { width: 0, height: 800 })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.kind).toBe("viewport-invalid")
  })

  test("NaN and Infinity are rejected before any arithmetic", () => {
    expect(CC.toPixels({ x: Number.NaN, y: 1 }, "pixels", VIEWPORT).ok).toBe(false)
    expect(CC.toPixels({ x: 1, y: Number.POSITIVE_INFINITY }, "pixels", VIEWPORT).ok).toBe(false)
  })
})

describe("fromPixels round-trips", () => {
  test("a known target expressed in the model's space converts back to itself", () => {
    const centre = { x: 1040, y: 582 }
    const normalized = unwrap(CC.fromPixels(centre, "normalized-1000", VIEWPORT))
    const back = unwrap(CC.toPixels(normalized, "normalized-1000", VIEWPORT))
    expect(back).toEqual(centre)
  })
})

describe("sniffSpace is a diagnostic and says so by being ambiguous", () => {
  test("a mid-screen point is legal in more than one space, which is why sniffing cannot be trusted", () => {
    const spaces = CC.sniffSpace({ x: 500, y: 400 }, VIEWPORT)
    expect(spaces).toContain("normalized-1000")
    expect(spaces).toContain("pixels")
    expect(spaces.length).toBeGreaterThan(1)
  })

  test("the asymmetry: a pixel-scale point rules OUT the normalized spaces", () => {
    expect(CC.sniffSpace({ x: 1042, y: 581 }, VIEWPORT)).toEqual(["pixels"])
  })
})
