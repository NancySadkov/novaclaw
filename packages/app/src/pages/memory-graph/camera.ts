// The CAMERA for the Memory graph viewer — the transform between the layout plane and the pixels the
// user actually has.
//
// 🔴 Why it is a separate concern from `layout.ts`. The layout plane is deterministic and CACHED per
// instance (`memory-graph.tsx` writes it to localStorage) so a re-open never reshuffles; making it
// depend on the window size would re-simulate — and move every node — the moment somebody resized.
// So the plane stays fixed and the camera does the fitting. The viewer used to do neither: it drew a
// 1000x700 plane at scale 1 into whatever box the flex layout gave it, which clips on a small window
// and strands the graph in the top-left corner of a large one.
//
// Pure math, no DOM: the render test asserts on the numbers rather than on a screenshot.

export interface Vec {
  x: number
  y: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Viewport {
  width: number
  height: number
}

/** The SVG content-group transform: `translate(tx ty) scale(scale)`. */
export interface View {
  tx: number
  ty: number
  scale: number
}

export const IDENTITY: View = { tx: 0, ty: 0, scale: 1 }

/** Zoom limits, shared with the wheel handler so a fit and a wheel can never disagree. */
export const MIN_SCALE = 0.2
export const MAX_SCALE = 5

/**
 * Never MAGNIFY on an auto-fit.
 *
 * A large window is fixed by centring, not by blowing three memories up to fill it — a two-node graph
 * scaled 5x reads as a diagram of nothing. Shrinking is the half that has to happen automatically,
 * because the alternative is a mark the user cannot reach.
 */
export const MAX_FIT_SCALE = 1

/** The bounding box of some points, or `undefined` when there are none. */
export function contentBounds(points: readonly Vec[]): Bounds | undefined {
  if (points.length === 0) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * The view that puts `bounds` fully inside `viewport`, centred, with `padding` px of margin.
 *
 * ⚠️ The padding is in SCREEN px and is subtracted BEFORE the scale is chosen, so it survives the
 * zoom — a node's label and its glyph radius live in that margin, and a fit computed without it puts
 * the outermost mark's edge exactly on the boundary.
 */
export function fitView(
  bounds: Bounds | undefined,
  viewport: Viewport,
  opts: { padding?: number; maxScale?: number } = {},
): View {
  const padding = opts.padding ?? 48
  const maxScale = opts.maxScale ?? MAX_FIT_SCALE
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) return IDENTITY
  const w = bounds.maxX - bounds.minX
  const h = bounds.maxY - bounds.minY
  // A viewport smaller than its own padding still has to yield a usable scale rather than 0 or NaN.
  const usableW = Math.max(1, viewport.width - padding * 2)
  const usableH = Math.max(1, viewport.height - padding * 2)
  const fit = Math.min(w > 0 ? usableW / w : Infinity, h > 0 ? usableH / h : Infinity)
  const scale = Math.max(MIN_SCALE, Math.min(maxScale, Number.isFinite(fit) ? fit : maxScale))
  return {
    tx: (viewport.width - w * scale) / 2 - bounds.minX * scale,
    ty: (viewport.height - h * scale) / 2 - bounds.minY * scale,
    scale,
  }
}

/** Where a plane point lands on screen under `view`. */
export const project = (p: Vec, view: View): Vec => ({ x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty })

/** Is a plane point inside the viewport under `view`, keeping `margin` px clear of the edge? */
export function isVisible(p: Vec, view: View, viewport: Viewport, margin = 24): boolean {
  const s = project(p, view)
  return s.x >= margin && s.y >= margin && s.x <= viewport.width - margin && s.y <= viewport.height - margin
}

/**
 * Pan (never zoom) so `p` sits at the centre — the "a selection that is off-screen" case.
 *
 * Zooming here would be the wrong repair: the user chose that zoom, and a click on a link in the
 * detail panel is a request to SEE the other end, not to change how close they are standing.
 */
export function centerOn(p: Vec, view: View, viewport: Viewport): View {
  return { tx: viewport.width / 2 - p.x * view.scale, ty: viewport.height / 2 - p.y * view.scale, scale: view.scale }
}
