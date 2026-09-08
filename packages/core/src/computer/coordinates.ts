export * as ComputerCoordinates from "./coordinates"

/**
 * Computer Use P1 — coordinate math between a grounding model's output space and screen pixels.
 *
 * **Why this is its own module with its own tests, rather than three lines at the call site.**
 * Getting it wrong does not crash, does not error, and does not look like a coordinate bug: every
 * click simply lands up and to the left, and the agent reads as a model that cannot ground. Measured
 * 2026-08-06: `Hcompany/Holo-3.1-35B-A3B-NVFP4` returned `{"x":814,"y":726}`
 * for a button whose true centre on a 1280x800 screenshot is `(1040,582)`. Read as pixels that is a
 * point in the upper-left quadrant, on a plausible-looking widget, with nothing anywhere reporting a
 * fault.
 *
 * ⚠️ **The output space is a property of the MODEL, not of the protocol, so this module never
 * guesses it.** Holo speaks `normalized-1000`; another grounder may speak pixels, or normalize to 1.
 * A caller declares the space and this module converts. See `sniffSpace` for why inference is
 * offered only as a diagnostic and must not be wired into the click path.
 */

/**
 * The space a grounding model emits points in.
 *
 * - `normalized-1000` — both axes scaled to `[0, 1000]` independently of aspect ratio. Holo-3.1.
 * - `normalized-1` — both axes scaled to `[0, 1]`. Common in research checkpoints.
 * - `pixels` — already screen pixels, relative to the screenshot's own top-left.
 */
export type Space = "normalized-1000" | "normalized-1" | "pixels"

/** Upper bound of each axis in a given space, or `undefined` when the space is the viewport itself. */
const axisMax = (space: Space): number | undefined =>
  space === "normalized-1000" ? 1000 : space === "normalized-1" ? 1 : undefined

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Viewport {
  readonly width: number
  readonly height: number
}

export type ConversionError =
  | { readonly kind: "not-finite"; readonly axis: "x" | "y"; readonly value: number }
  | { readonly kind: "viewport-invalid"; readonly viewport: Viewport }
  | {
      /**
       * The point is outside the declared space's range. Carries `alsoValidAs` when the value WOULD
       * be in range under a different space, which is the single most useful thing to say here: it
       * turns "the model is bad at grounding" into "the model's space is declared wrong".
       */
      readonly kind: "out-of-range"
      readonly axis: "x" | "y"
      readonly value: number
      readonly max: number
      readonly alsoValidAs: ReadonlyArray<Space>
    }

export type Conversion = { readonly ok: true; readonly point: Point } | { readonly ok: false; readonly error: ConversionError }

/** Spaces (other than `declared`) in which `value` would be a legal coordinate on `extent`. */
const otherSpacesAccepting = (value: number, extent: number, declared: Space): ReadonlyArray<Space> => {
  const spaces: Space[] = ["normalized-1", "normalized-1000", "pixels"]
  return spaces.filter((space) => {
    if (space === declared) return false
    const max = axisMax(space) ?? extent
    return value >= 0 && value <= max
  })
}

/**
 * Convert one point from a model's declared output space into screen pixels.
 *
 * Rounds to the nearest whole pixel — a click target is a pixel, and carrying a fraction into an OS
 * click API only invites each backend to round it differently.
 *
 * ⚠️ **Out of range is an ERROR, never a clamp.** Clamping a stray point to the screen edge produces
 * a click that is silently in the wrong place, which is the same class of fault this module exists to
 * prevent (`notes/reports/decisions-v0.2.0.md` ruling 2 — a fault is never described falsely). The
 * caller decides whether to
 * re-ask the model, and it can only decide if it is told.
 */
export const toPixels = (point: Point, space: Space, viewport: Viewport): Conversion => {
  if (!Number.isFinite(point.x)) return { ok: false, error: { kind: "not-finite", axis: "x", value: point.x } }
  if (!Number.isFinite(point.y)) return { ok: false, error: { kind: "not-finite", axis: "y", value: point.y } }
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return { ok: false, error: { kind: "viewport-invalid", viewport } }

  const max = axisMax(space)
  const limits = { x: max ?? viewport.width, y: max ?? viewport.height }
  for (const axis of ["x", "y"] as const) {
    const value = point[axis]
    const extent = axis === "x" ? viewport.width : viewport.height
    if (value < 0 || value > limits[axis])
      return {
        ok: false,
        error: {
          kind: "out-of-range",
          axis,
          value,
          max: limits[axis],
          alsoValidAs: otherSpacesAccepting(value, extent, space),
        },
      }
  }

  if (space === "pixels") return { ok: true, point: { x: Math.round(point.x), y: Math.round(point.y) } }
  const divisor = max as number
  return {
    ok: true,
    point: {
      x: Math.round((point.x / divisor) * viewport.width),
      y: Math.round((point.y / divisor) * viewport.height),
    },
  }
}

/** The inverse of {@link toPixels}. Used to express a known target back in a model's own space. */
export const fromPixels = (point: Point, space: Space, viewport: Viewport): Conversion => {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return { ok: false, error: { kind: "viewport-invalid", viewport } }
  if (space === "pixels") return toPixels(point, "pixels", viewport)
  const max = axisMax(space) as number
  return {
    ok: true,
    point: { x: (point.x / viewport.width) * max, y: (point.y / viewport.height) * max },
  }
}

/**
 * DIAGNOSTIC ONLY — report which spaces a point could legally belong to.
 *
 * 🔴 **Never wire this into the click path.** The spaces overlap by construction, so for a large
 * region of any realistic screen the answer is genuinely ambiguous: on 1280x800, `(500, 400)` is a
 * legal pixel point AND a legal `normalized-1000` point, and nothing about the number distinguishes
 * them. Sniffing therefore cannot be made correct — it can only be made *usually* correct, which is
 * the worst property for something whose failure is a silent misclick.
 *
 * The asymmetry is worth stating because it decides where a real check can live: a model that
 * declares `normalized-1000` but emits pixels is usually CAUGHT (values above 1000 on a wide screen
 * are out of range), while a model that declares `pixels` but emits normalized is NEVER caught — the
 * point is a perfectly ordinary pixel coordinate in the top-left. So the declaration must come from
 * the model's own registration, and this function exists to explain a failure after the fact.
 */
export const sniffSpace = (point: Point, viewport: Viewport): ReadonlyArray<Space> => {
  const spaces: Space[] = ["normalized-1", "normalized-1000", "pixels"]
  return spaces.filter((space) => {
    const max = axisMax(space)
    const limitX = max ?? viewport.width
    const limitY = max ?? viewport.height
    return point.x >= 0 && point.x <= limitX && point.y >= 0 && point.y <= limitY
  })
}

/** True when `point` (already in pixels) lies within the inclusive box. Used to score a grounding probe. */
export const withinBox = (
  point: Point,
  box: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number },
): boolean => point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2
