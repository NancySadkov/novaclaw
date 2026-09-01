// A dependency-free, DETERMINISTIC force-directed layout for the Memory graph viewer
// (the advanced node-link surface). No Sigma/graphology/d3: the memory
// graph is small (tens–low-hundreds of nodes), local-first/airgap wants a self-contained bundle, and
// the owner's steer is to NOT deepen npm coupling. Fruchterman–Reingold with NO randomness → the same
// (nodes, edges, seed) always yields the same positions, which IS the "stable layout" crux: a re-open
// never reshuffles. Growth stays stable too — the caller passes prior positions as `seed`, so existing
// nodes keep their place and only new nodes (deterministically hash-seeded) settle in around them.

export interface Vec {
  x: number
  y: number
}

export interface LayoutEdge {
  readonly from: string
  readonly to: string
}

/** Fraction of each plane axis the connected core may use when there are orphans to band around it. */
const CORE_INSET = 0.62
/** Fraction of each plane axis the orphan band sits at. Must exceed CORE_INSET — see `bandOrphans`. */
const BAND_RADIUS = 0.47

export interface LayoutOptions {
  width?: number
  height?: number
  iterations?: number
  /** Prior positions (e.g. from a cache) — existing nodes start here so the layout stays stable. */
  seed?: Readonly<Record<string, Vec>>
  /** Cap on the O(n²) repulsion pass; above it, layout still runs (edges only) but repulsion is skipped. */
  maxNodes?: number
}

// FNV-1a → a stable [0,1) from a string id, so an unseeded node always starts in the same place.
function hash01(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Deterministically lay out a graph. Returns a position for every id in `nodeIds`. Connected nodes are
 * pulled together, all nodes repel, and the result is clamped into `[0,width]×[0,height]`.
 */
export function layoutGraph(
  nodeIds: readonly string[],
  edges: readonly LayoutEdge[],
  opts: LayoutOptions = {},
): Record<string, Vec> {
  const width = opts.width ?? 1000
  const height = opts.height ?? 700
  const iterations = opts.iterations ?? 300
  const maxNodes = opts.maxNodes ?? 400
  const cx = width / 2
  const cy = height / 2

  const ids = [...nodeIds]
  const n = ids.length
  const pos: Record<string, Vec> = {}
  if (n === 0) return pos

  // Seed: prior position if given, else a deterministic point on a spiral around the centre.
  ids.forEach((id, i) => {
    const prior = opts.seed?.[id]
    if (prior) {
      pos[id] = { x: prior.x, y: prior.y }
      return
    }
    const angle = hash01(id) * Math.PI * 2
    const radius = (0.15 + 0.35 * ((i + 1) / n)) * Math.min(width, height)
    pos[id] = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
  })

  // Only keep edges whose endpoints exist (guards dangling references from the server slice).
  const present = new Set(ids)
  const es = edges.filter((e) => present.has(e.from) && present.has(e.to) && e.from !== e.to)

  // Who has no link at all. An orphan is pulled to the centre by the same gravity as everything else,
  // so it lands among the connected nodes and reads as part of the structure — the map implying a
  // relationship that does not exist. It gets its own band instead; see `bandOrphans`.
  const linked = new Set<string>()
  for (const e of es) {
    linked.add(e.from)
    linked.add(e.to)
  }
  const orphans = ids.filter((id) => !linked.has(id))

  // THE CORE BOX. With orphans to place, the connected nodes are confined to the middle of the plane
  // so the band has somewhere to be. Without them the core is the whole plane, unchanged — measured
  // reason: three nodes on a 1000x700 plane spread to its four corners, leaving a "band" no room and
  // an orphan indistinguishable from a linked node at the same radius.
  //
  // ⚠️ This means a linked node MOVES when an unrelated orphan appears. That is a real cost and it is
  // accepted: the alternative is a picture that cannot say which memories stand alone. The camera
  // refits either way, so on screen the core keeps its size — only the plane coordinates change.
  const banding = orphans.length > 0 && linked.size > 0
  const coreW = banding ? width * CORE_INSET : width
  const coreH = banding ? height * CORE_INSET : height
  const minX = cx - coreW / 2
  const maxX = cx + coreW / 2
  const minY = cy - coreH / 2
  const maxY = cy + coreH / 2

  // Fruchterman–Reingold ideal edge length k, and a linear cooling schedule — both sized to the CORE,
  // not the plane, or the layout keeps trying to fill space the band owns.
  const area = coreW * coreH
  const k = Math.sqrt(area / n) * 0.8
  const repel = n <= maxNodes // skip the O(n²) pass on very large graphs
  let temp = Math.min(coreW, coreH) / 8

  for (let iter = 0; iter < iterations; iter++) {
    const disp: Record<string, Vec> = {}
    for (const id of ids) disp[id] = { x: 0, y: 0 }

    // Repulsion between every pair.
    if (repel) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = pos[ids[i]!]!
          const b = pos[ids[j]!]!
          let dx = a.x - b.x
          let dy = a.y - b.y
          let dist = Math.hypot(dx, dy)
          if (dist < 0.01) {
            // Deterministic nudge for coincident nodes (no Math.random).
            dx = (hash01(ids[i]!) - 0.5) * 0.1
            dy = (hash01(ids[j]!) - 0.5) * 0.1
            dist = Math.hypot(dx, dy) || 0.01
          }
          const force = (k * k) / dist
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          disp[ids[i]!]!.x += fx
          disp[ids[i]!]!.y += fy
          disp[ids[j]!]!.x -= fx
          disp[ids[j]!]!.y -= fy
        }
      }
    }

    // Attraction along edges.
    for (const e of es) {
      const a = pos[e.from]!
      const b = pos[e.to]!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.hypot(dx, dy) || 0.01
      const force = (dist * dist) / k
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      disp[e.from]!.x -= fx
      disp[e.from]!.y -= fy
      disp[e.to]!.x += fx
      disp[e.to]!.y += fy
    }

    // Gentle pull toward the centre so disconnected components don't drift off-canvas.
    for (const id of ids) {
      disp[id]!.x += (cx - pos[id]!.x) * 0.01
      disp[id]!.y += (cy - pos[id]!.y) * 0.01
    }

    // Apply, capped by the current temperature, then cool.
    for (const id of ids) {
      const d = disp[id]!
      const len = Math.hypot(d.x, d.y) || 0.01
      const step = Math.min(len, temp)
      const p = pos[id]!
      p.x = Math.max(minX, Math.min(maxX, p.x + (d.x / len) * step))
      p.y = Math.max(minY, Math.min(maxY, p.y + (d.y / len) * step))
    }
    temp = Math.max(temp * 0.97, 0.5)
  }

  bandOrphans(pos, orphans, linked, { width, height })
  return pos
}

/**
 * Put every unlinked memory in a deliberate OUTER BAND, outside whatever the connected core occupies.
 *
 * 🔴 Why it is not enough to simply not draw an edge. The layout's gravity pulls every node toward the
 * centre, so an orphan settles wherever the repulsion happens to leave it — usually among the
 * connected nodes, reading as one of them. The user then sees a memory sitting inside a cluster it has
 * no relationship with, which is the map asserting something the store never said. The honest
 * alternatives are to invent a link (never) or to give unlinked memories a place of their own.
 *
 * ⚠️ **The band OVERRIDES the seed**, unlike every other position here. A cached position is worth
 * respecting because it keeps a node where the user last saw it; a cached position for an orphan is
 * just an older accident, and honouring it would scatter the band it exists to form. A memory that
 * gains its first edge therefore MOVES — correctly, because it stopped being an orphan.
 *
 * ⚠️ **No edges at all means no band.** A band is "outside the core", and a graph with no links has no
 * core to be outside of — a ring there would be a shape invented from nothing, and it would also throw
 * away the seeded positions that make a re-open stable.
 */
function bandOrphans(
  pos: Record<string, Vec>,
  orphans: readonly string[],
  linked: ReadonlySet<string>,
  plane: { width: number; height: number },
): void {
  if (orphans.length === 0 || linked.size === 0) return
  const cx = plane.width / 2
  const cy = plane.height / 2
  // An ELLIPSE matching the plane's aspect, not a circle. `CORE_INSET` confines the connected nodes to
  // the middle 62% of each axis, and `BAND_RADIUS` is 47% — so a band point can only be inside the
  // core's box if BOTH |cos| and |sin| are under 0.62/0.47, which they cannot be at once. That is the
  // whole geometric claim: outside the core in at least one axis, always, at every angle. A circle
  // would fail it on the short axis of a wide plane.
  const rx = plane.width * BAND_RADIUS
  const ry = plane.height * BAND_RADIUS

  // Sorted, so the band's order is a property of the ids rather than of the order rows arrived in —
  // two loads of the same memories put the same one at the top.
  const ring = [...orphans].sort()
  for (let i = 0; i < ring.length; i++) {
    const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2
    pos[ring[i]!] = {
      x: Math.max(0, Math.min(plane.width, cx + Math.cos(angle) * rx)),
      y: Math.max(0, Math.min(plane.height, cy + Math.sin(angle) * ry)),
    }
  }
}
