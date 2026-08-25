/**
 * WHICH LABELS GET DRAWN — greedy, priority-ordered, overlap-free placement in SCREEN space.
 *
 * 🔴 Two defects, and they are the same defect. The viewer drew a label for every mark once the count
 * dropped under 40 and none above it, so a 41-node graph was anonymous dots and a 39-node one was a
 * pile of overlapping text. And the labels lived INSIDE the zoomed group, so they shrank to
 * illegibility as you zoomed out and became billboards as you zoomed in — which also meant "do these
 * two labels overlap?" had no stable answer to cull on.
 *
 * So labels are placed in screen pixels, at a fixed size, and a label that would land on top of one
 * already placed is dropped rather than stacked. The count threshold disappears: what fits, fits.
 *
 * ⚠️ **Priority is what makes dropping acceptable.** Culling without an order silently hides whatever
 * the loop reached last. The order below is the reading order of the question the map answers — what
 * did I click, what is it connected to, what is standing on its own — and it is stable, so a redraw
 * never swaps which of two colliding labels survives.
 */

export interface LabelCandidate {
  readonly id: string
  readonly text: string
  /** Screen position of the MARK. The label is placed to its right, like a callout. */
  readonly x: number
  readonly y: number
  readonly priority: Priority
}

/**
 * Higher wins. Gaps are deliberate: `RecallHit` is the slot P2's recall highlighting fills, and
 * leaving it numbered now stops that change from having to renumber the rest.
 */
export const Priority = {
  Selected: 100,
  Neighbor: 80,
  RecallHit: 70,
  /** A hub's entire content IS its label — an unlabelled one is a dashed shape meaning nothing. */
  Hub: 60,
  /** Nothing near it, so its label is free: it can never be the thing crowding somebody out. */
  Isolated: 40,
  Ordinary: 20,
} as const
export type Priority = (typeof Priority)[keyof typeof Priority]

export interface PlaceOptions {
  /** The visible box; a label outside it is not drawn. */
  readonly viewport: { readonly width: number; readonly height: number }
  /** Gap between the mark and its text, in px. */
  readonly offsetX?: number
  /** Approximate advance width of one character at the label's font size. */
  readonly charWidth?: number
  readonly lineHeight?: number
  /** Breathing room added around each placed box before testing the next one. */
  readonly padding?: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * How isolated a mark is: the distance in screen px to its nearest neighbour, capped so the caller can
 * compare against a threshold without an unbounded scan mattering.
 *
 * O(n²) and deliberately so — the memory graph is tens to low hundreds of marks, and a grid index here
 * would be a second spatial structure to keep correct for a loop that costs microseconds.
 */
export function nearestNeighborDistance(points: readonly { x: number; y: number }[], index: number): number {
  const self = points[index]
  if (!self) return Infinity
  let best = Infinity
  for (let i = 0; i < points.length; i++) {
    if (i === index) continue
    const other = points[i]!
    const d = Math.hypot(self.x - other.x, self.y - other.y)
    if (d < best) best = d
  }
  return best
}

/**
 * Decide which candidates get a label.
 *
 * Returns the ids to draw. Ties in priority break on `id`, so the survivor of a collision is a
 * property of the data and not of iteration order — a redraw never flips which one you can read.
 */
export function placeLabels(candidates: readonly LabelCandidate[], opts: PlaceOptions): ReadonlySet<string> {
  const offsetX = opts.offsetX ?? 13
  const charWidth = opts.charWidth ?? 5.6
  const lineHeight = opts.lineHeight ?? 13
  const padding = opts.padding ?? 2
  const { width, height } = opts.viewport

  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const placed: Box[] = []
  const drawn = new Set<string>()

  for (const candidate of ordered) {
    const box: Box = {
      x: candidate.x + offsetX - padding,
      y: candidate.y - lineHeight / 2 - padding,
      w: candidate.text.length * charWidth + padding * 2,
      h: lineHeight + padding * 2,
    }
    // Off-screen text is not a label, it is a thing the browser lays out and nobody reads. Dropping it
    // also frees its slot for a mark that IS visible.
    if (box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) continue
    if (placed.some((other) => overlaps(box, other))) continue
    placed.push(box)
    drawn.add(candidate.id)
  }
  return drawn
}
