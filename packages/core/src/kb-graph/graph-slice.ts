/**
 * WHICH memories go in a bounded graph slice — the selection, as pure logic.
 *
 * 🔴 The defect this replaces. `graph()` took the newest N rows and then kept the edges among them.
 * Ingesting one document writes hundreds of passages in a burst, so "the newest N" becomes that one
 * document, and every older entity hub — the things the user actually named and asked about — falls
 * off the end. The graph got emptier the more was put into it, and nothing said so.
 *
 * 🔴 And the opposite failure is just as easy. Ranking purely by connectivity puts the oldest, most
 * linked cluster on screen forever and makes yesterday's memory invisible. So the budget is SPLIT:
 * most of it goes to structure (hubs and their neighbourhoods), a reserved share to recency. Neither
 * axis can starve the other, and the result says which mix produced it.
 *
 * ⚠️ Pure, and computed in JS from two cheap scans, because of what the engine cannot do. On the
 * owner's store `WHERE m.id IN $ids` HANGS, pinning gigabytes before it is killed, and so does
 * `WITH m ORDER BY … RETURN …` (see `hydrate` in `wasm-engine.ts`). A selection expressed as a query
 * would have to use exactly those. Ids, kinds and scopes survive a scan intact — only long strings
 * come back blank — so scanning ids and deciding here is the shape that works.
 */

export interface SliceNode {
  readonly id: string
  readonly kind: string
}

export interface SliceEdge {
  readonly from: string
  readonly to: string
}

/** How the slice was chosen, so the client can say what it is looking at. */
export interface SliceMeta {
  /** Are there valid memories in scope that this slice does not contain? */
  readonly partial: boolean
  /** Valid memories in scope, counted independently of the scan. */
  readonly total: number
  readonly returned: number
  readonly omitted: number
  /**
   * Why this set.
   * - `complete` — everything in scope fits; nothing was left out.
   * - `connected-first` — over budget, so hubs and their neighbourhoods were taken first, with a
   *   reserved share of the budget spent on the newest memories.
   * - `scan-capped` — the store holds more rows than one scan will read, so even `total` describes
   *   more than was considered. The honest worst case, and it says so rather than pretending.
   */
  readonly reason: "complete" | "connected-first" | "scan-capped"
}

export interface SliceResult {
  /** The chosen ids, in the order they should be hydrated. */
  readonly ids: readonly string[]
  readonly meta: SliceMeta
}

/**
 * Share of the budget reserved for the NEWEST memories, whatever their connectivity.
 *
 * Without it, a store with one big old cluster shows that cluster and nothing else, forever — the
 * mirror image of the defect being fixed. A quarter is enough that a recent memory is always
 * reachable and small enough that structure still dominates the picture.
 */
export const RECENCY_SHARE = 0.25

export interface SelectOptions {
  /** How many nodes the slice may contain. */
  readonly limit: number
  /** Valid memories in scope, counted by the store rather than inferred from `nodes`. */
  readonly total: number
  /** Did the id scan hit its own cap — i.e. is `nodes` itself already incomplete? */
  readonly scanCapped?: boolean
}

/**
 * Choose the slice.
 *
 * `nodes` must arrive NEWEST FIRST — that order is the recency signal, and it is the order the store's
 * `ORDER BY t_created DESC` scan already produces, so nothing has to carry a timestamp through.
 */
export function selectSlice(
  nodes: readonly SliceNode[],
  edges: readonly SliceEdge[],
  opts: SelectOptions,
): SliceResult {
  const limit = Math.max(1, Math.trunc(opts.limit))
  const present = new Set(nodes.map((n) => n.id))
  const total = Math.max(opts.total, nodes.length)

  if (nodes.length <= limit) {
    // Everything scanned fits. It is still PARTIAL when the store holds more than the scan read, or
    // more than the count of what we have — both are ways of having seen less than there is.
    const partial = opts.scanCapped === true || total > nodes.length
    return {
      ids: nodes.map((n) => n.id),
      meta: {
        partial,
        total,
        returned: nodes.length,
        omitted: Math.max(0, total - nodes.length),
        reason: partial ? "scan-capped" : "complete",
      },
    }
  }

  // Adjacency and degree, from edges whose BOTH endpoints were scanned — a half-present edge says
  // nothing about the connectivity of what we can actually offer.
  const neighbors = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    const set = neighbors.get(from)
    if (set) set.add(to)
    else neighbors.set(from, new Set([to]))
  }
  for (const edge of edges) {
    if (edge.from === edge.to) continue
    if (!present.has(edge.from) || !present.has(edge.to)) continue
    link(edge.from, edge.to)
    link(edge.to, edge.from)
  }
  // DEGREE counts distinct neighbours, not stored edges — two memories joined by three relations are
  // one connection's worth of structure, and counting the relations would let a chatty edge type
  // decide what the user sees.
  const degree = (id: string) => neighbors.get(id)?.size ?? 0

  /** Scan position — the recency rank, and the tiebreak that keeps this deterministic. */
  const order = new Map<string, number>()
  nodes.forEach((n, i) => order.set(n.id, i))
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER
  /** More connected first; among equals, newer first. Total and deterministic. */
  const byStructure = (a: string, b: string) => degree(b) - degree(a) || rank(a) - rank(b)

  const recencyBudget = Math.min(limit, Math.max(1, Math.round(limit * RECENCY_SHARE)))
  const structureBudget = limit - recencyBudget

  const chosen = new Set<string>()
  const ids: string[] = []
  const take = (id: string) => {
    if (chosen.has(id)) return
    chosen.add(id)
    ids.push(id)
  }

  // Structure: walk out from the most connected node, then its neighbours by connectivity, so a hub
  // arrives WITH the things that make it a hub rather than as a lone mark whose edges point nowhere.
  // When a component is exhausted the next-best unvisited root starts the next one.
  const roots = [...present].sort(byStructure)
  let rootIndex = 0
  const queue: string[] = []
  while (chosen.size < structureBudget) {
    if (queue.length === 0) {
      while (rootIndex < roots.length && chosen.has(roots[rootIndex]!)) rootIndex += 1
      if (rootIndex >= roots.length) break
      queue.push(roots[rootIndex]!)
      rootIndex += 1
    }
    const id = queue.shift()!
    if (chosen.has(id)) continue
    take(id)
    const near = neighbors.get(id)
    if (near) for (const next of [...near].sort(byStructure)) if (!chosen.has(next)) queue.push(next)
  }

  // Recency: the newest memories, whatever they are attached to.
  for (const node of nodes) {
    if (ids.length >= limit) break
    take(node.id)
  }

  return {
    ids,
    meta: {
      partial: true,
      total,
      returned: ids.length,
      omitted: Math.max(0, total - ids.length),
      reason: opts.scanCapped === true ? "scan-capped" : "connected-first",
    },
  }
}
