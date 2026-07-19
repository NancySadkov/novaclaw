// A dependency-free, DETERMINISTIC force-directed layout for the Memory graph viewer
// (notes/kb-graph-plan.md §5 — the advanced node-link surface). No Sigma/graphology/d3: the memory
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
export function layoutGraph(nodeIds: readonly string[], edges: readonly LayoutEdge[], opts: LayoutOptions = {}): Record<string, Vec> {
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

  // Fruchterman–Reingold ideal edge length k, and a linear cooling schedule.
  const area = width * height
  const k = Math.sqrt(area / n) * 0.8
  const repel = n <= maxNodes // skip the O(n²) pass on very large graphs
  let temp = Math.min(width, height) / 8

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
      p.x = Math.max(0, Math.min(width, p.x + (d.x / len) * step))
      p.y = Math.max(0, Math.min(height, p.y + (d.y / len) * step))
    }
    temp = Math.max(temp * 0.97, 0.5)
  }

  return pos
}
