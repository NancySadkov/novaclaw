import type { EdgeRow, MemoryRow } from "@/utils/memory-api"

/**
 * The VISIBLE PROJECTION of the memory graph — what the viewer actually lays out and draws.
 *
 * 🔴 The defect this closes. Passages are hidden by default (measured on a real instance: 202 of 281
 * nodes, and the canvas reads as a wall of identical marks with them on). But hiding them was done at
 * RENDER only: every hidden passage still pulled on the force layout, and every edge with a hidden
 * endpoint was simply not drawn. Ingestion is the case that makes this bite — a document is stored as
 * an ENTITY with `passage -part_of-> document` edges, and absorbing passages adds
 * `passage -mentions-> entity`. So an extracted entity's ONLY path to its document runs through a
 * passage. Hide passages and the default view keeps the marks but deletes the structure: a document
 * hub with nothing attached, and its own extracted entities floating loose beside it, connected to
 * nothing.
 *
 * 🔴 What it does NOT do, and why. The cheap repair is to bridge the gap — draw `document -> entity`
 * because a passage joined them. That is an entity-to-entity edge nobody stored, indistinguishable
 * from a real one once drawn, and it makes the map assert a relation the memory does not hold. Instead
 * the hidden nodes COLLAPSE into an explicitly synthetic hub ("202 passages"), and the real edges are
 * re-pointed at it. The structure survives, every drawn edge still has a stored edge behind it, and
 * the one node that is not a memory says so on its face.
 */

/** A mark on the canvas: either one real memory, or the hub standing for a group of hidden ones. */
export type ProjectedNode =
  | { readonly kind: "memory"; readonly id: string; readonly row: MemoryRow }
  | {
      readonly kind: "hub"
      readonly id: string
      /** How many hidden memories this hub stands for. */
      readonly count: number
      /** The memory kind they share — `passage`, `episode`, … */
      readonly of: string
      /** The visible node they all hang off, when they share one. */
      readonly anchor: string | undefined
      /** Their common scope, or `undefined` when they disagree — a hub is not a scope claim. */
      readonly scope: string | undefined
    }

/** A drawn link. `count` is how many stored edges it stands for (always 1 between two real nodes). */
export interface ProjectedEdge {
  readonly from: string
  readonly to: string
  readonly type: string
  readonly count: number
}

export interface Projection {
  readonly nodes: readonly ProjectedNode[]
  readonly edges: readonly ProjectedEdge[]
  /** Real memories not drawn as themselves — the number the header reports as hidden. */
  readonly hiddenCount: number
}

/**
 * The relation that says "this hidden thing BELONGS to that visible thing".
 *
 * Ingestion writes exactly this edge from every passage to its document
 * (`handlers/memory.ts` — `.addEdge({ from: passage, to: documentID, type: "part_of" })`), which is
 * what lets a hub sit beside the document it came from rather than in a single anonymous pile.
 */
const CONTAINMENT = "part_of"

export const HUB_LOOSE = "loose"

const hubID = (anchor: string | undefined, kind: string) => `hub:${anchor ?? HUB_LOOSE}:${kind}`

export function isHub(node: ProjectedNode): node is Extract<ProjectedNode, { kind: "hub" }> {
  return node.kind === "hub"
}

/** "202 passages" / "1 passage" — plural by the only rule English needs here. */
export function hubLabel(node: Extract<ProjectedNode, { kind: "hub" }>): string {
  return `${node.count} ${node.of}${node.count === 1 ? "" : "s"}`
}

/**
 * Project `nodes`/`edges` down to what `visible` admits.
 *
 * `visible` is asked about a node's KIND, matching the viewer's kind chips. Anything it rejects is
 * collapsed rather than deleted.
 */
export function projectGraph(
  nodes: readonly MemoryRow[],
  edges: readonly EdgeRow[],
  visible: (kind: string) => boolean,
): Projection {
  const shown = new Map<string, MemoryRow>()
  const hidden = new Map<string, MemoryRow>()
  for (const node of nodes) (visible(node.kind) ? shown : hidden).set(node.id, node)

  if (hidden.size === 0) {
    // Nothing to collapse — the common case, and it must not pay for the machinery below.
    const known = (id: string) => shown.has(id)
    return {
      nodes: nodes.map((row) => ({ kind: "memory", id: row.id, row }) as const),
      edges: edges.filter((e) => known(e.from) && known(e.to)).map((e) => ({ ...e, count: 1 })),
      hiddenCount: 0,
    }
  }

  // Which VISIBLE node each hidden node belongs to, from its own containment edge. A hidden node whose
  // container is also hidden is treated as loose rather than chained: a hub of hubs would be a
  // structure the user cannot decode, and the count it reports would stop meaning "memories".
  const anchorOf = new Map<string, string>()
  for (const edge of edges) {
    if (edge.type !== CONTAINMENT) continue
    if (!hidden.has(edge.from) || !shown.has(edge.to)) continue
    if (!anchorOf.has(edge.from)) anchorOf.set(edge.from, edge.to)
  }

  /** hidden node id -> the hub that now stands for it. */
  const hubOf = new Map<string, string>()
  const hubs = new Map<string, { count: number; of: string; anchor: string | undefined; scope: string | undefined }>()
  for (const [id, row] of hidden) {
    const anchor = anchorOf.get(id)
    const key = hubID(anchor, row.kind)
    hubOf.set(id, key)
    const existing = hubs.get(key)
    if (!existing) {
      hubs.set(key, { count: 1, of: row.kind, anchor, scope: row.scope })
      continue
    }
    existing.count += 1
    // A hub whose members disagree about scope reports NO scope. Painting it with the first member's
    // colour would say "these 202 memories are shared with everyone" on the strength of one of them.
    if (existing.scope !== row.scope) existing.scope = undefined
  }

  const at = (id: string) => (shown.has(id) ? id : hubOf.get(id))

  // Re-point every edge at whatever now stands for its endpoints, then merge the duplicates that
  // creates. 202 `passage -part_of-> document` edges become ONE `hub -part_of-> document` of count 202.
  const merged = new Map<string, { from: string; to: string; type: string; count: number }>()
  for (const edge of edges) {
    const from = at(edge.from)
    const to = at(edge.to)
    if (from === undefined || to === undefined) continue
    // A loop on a hub is the collapse's own internal wiring — the edges BETWEEN the passages of one
    // document. Drawing it would be the graph reporting on its own summarisation.
    if (from === to) continue
    // ⚠️ The separator is written as an ESCAPE, never as the character. This line was authored
    // with two raw NUL bytes in it, invisible in every view, and `core/test/invisible-characters.test.ts`
    // is what caught them — a NUL removes the whole file from ripgrep and `git diff`. NUL is still the
    // right delimiter (no id or relation type can contain one, so no key can collide); it just has to be
    // spelled.
    const key = `${from}\u0000${to}\u0000${edge.type}`
    const existing = merged.get(key)
    if (existing) existing.count += 1
    else merged.set(key, { from, to, type: edge.type, count: 1 })
  }

  // A hub nothing connects to is a bare "202 passages" floating in space, which tells the user less
  // than the header's hidden count already does.
  const connected = new Set<string>()
  for (const edge of merged.values()) {
    connected.add(edge.from)
    connected.add(edge.to)
  }

  const projected: ProjectedNode[] = []
  for (const row of nodes) if (shown.has(row.id)) projected.push({ kind: "memory", id: row.id, row })
  for (const [id, hub] of hubs) {
    if (!connected.has(id)) continue
    projected.push({ kind: "hub", id, count: hub.count, of: hub.of, anchor: hub.anchor, scope: hub.scope })
  }
  const live = new Set(projected.map((n) => n.id))

  return {
    nodes: projected,
    edges: [...merged.values()].filter((e) => live.has(e.from) && live.has(e.to)),
    hiddenCount: hidden.size,
  }
}
