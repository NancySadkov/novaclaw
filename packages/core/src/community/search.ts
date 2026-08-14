export * as CommunitySearch from "./search"

/**
 * Community P5 — throttled broadcast search (`todo/community-p2p.md`).
 *
 * Owner's decision: search is a **request-count-throttled broadcast**, no servers, any one living
 * node a complete entry point. That is the Gnutella lineage, and Gnutella collapsed in 2001 because
 * query traffic grew with users × hops until it saturated the slowest links. The three controls
 * whose absence caused that are the whole of this module:
 *
 *   1. **hop-limited TTL** — a query dies after N hops. Without it, throttling only delays a flood.
 *   2. **duplicate suppression by id** — a node that has seen a query neither answers nor forwards
 *      it again. This is what stops exponential re-broadcast in a CYCLIC graph, which every real
 *      peer network is.
 *   3. **dynamic widening** — ask a few peers first, widen only if too few results come back, rather
 *      than always paying full fan-out.
 *
 * 🔴 Pure and transport-independent ON PURPOSE. These rules decide whether the network survives its
 * own traffic, and they are cheaper to get right in a test than in a mesh — the same reason the
 * message envelope was built before anything could carry it.
 */

/** How long a seen-id is remembered. Long enough to outlive a query's own propagation. */
export const SEEN_TTL_MS = 60_000

/** Hops a query may travel before it dies. 4 reaches a large network without flooding it. */
export const DEFAULT_TTL = 4

/** Peers asked in the first wave. Widening happens only if this wave under-delivers. */
export const FIRST_WAVE = 3

export interface Query {
  /** Stable across the whole broadcast — the dedup key every node uses. */
  readonly id: string
  readonly terms: string
  /** Remaining hops. Decremented on each forward; at 0 the query stops. */
  readonly ttl: number
  /** Who asked, so results can be routed back. */
  readonly origin: string
}

export type Verdict =
  | { readonly forward: true; readonly next: Query }
  /** Named reasons, because "did not forward" with no cause is unreadable in a mesh. */
  | { readonly forward: false; readonly reason: "duplicate" | "expired" | "throttled" | "own-query" }

/**
 * Remembers query ids for a bounded time.
 *
 * ⚠️ Bounded, not permanent. A permanent set is a memory leak an attacker fills for free by sending
 * unique ids; forgetting after `SEEN_TTL_MS` costs at worst one extra forward of a very old query,
 * which its TTL then kills anyway.
 */
export class Seen {
  private readonly at = new Map<string, number>()

  constructor(private readonly ttlMs: number = SEEN_TTL_MS) {}

  /** True when this id has been seen recently. Expired entries are dropped as they are met. */
  has(id: string, now: number): boolean {
    const stamp = this.at.get(id)
    if (stamp === undefined) return false
    if (now - stamp > this.ttlMs) {
      this.at.delete(id)
      return false
    }
    return true
  }

  remember(id: string, now: number): void {
    this.at.set(id, now)
  }

  /** Drop everything older than the window. Called periodically, not per query. */
  prune(now: number): void {
    for (const [id, stamp] of this.at) if (now - stamp > this.ttlMs) this.at.delete(id)
  }

  get size(): number {
    return this.at.size
  }
}

/**
 * Counts queries per ORIGIN in a rolling window — the owner's "request count throttle".
 *
 * ⚠️ Keyed on the origin, not the sender. A flooder that relays its own queries through different
 * neighbours would otherwise get a fresh budget per neighbour, which is the whole attack.
 */
export class Throttle {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number = 10,
    private readonly windowMs: number = 10_000,
  ) {}

  /** Records an attempt and says whether it is within budget. */
  allow(origin: string, now: number): boolean {
    const recent = (this.hits.get(origin) ?? []).filter((stamp) => now - stamp < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(origin, recent)
      return false
    }
    recent.push(now)
    this.hits.set(origin, recent)
    return true
  }
}

/**
 * Should this node forward the query it just received?
 *
 * The order is deliberate: identity first (never relay our own query back into the network), then
 * duplicate, then TTL, then the throttle. Cheapest and most decisive checks before the one that has
 * to touch a rolling window.
 */
export const consider = (
  query: Query,
  context: { readonly self: string; readonly seen: Seen; readonly throttle: Throttle; readonly now: number },
): Verdict => {
  if (query.origin === context.self) return { forward: false, reason: "own-query" }
  if (context.seen.has(query.id, context.now)) return { forward: false, reason: "duplicate" }
  // Remember BEFORE the remaining checks: a query we refuse for TTL or throttle must still not be
  // reconsidered when the same id arrives from another neighbour a moment later.
  context.seen.remember(query.id, context.now)
  if (query.ttl <= 1) return { forward: false, reason: "expired" }
  if (!context.throttle.allow(query.origin, context.now)) return { forward: false, reason: "throttled" }
  return { forward: true, next: { ...query, ttl: query.ttl - 1 } }
}

/**
 * How many more peers to ask after a wave returned `results`.
 *
 * Dynamic widening: a wave that answered the question costs nothing more. Gnutella 0.6 added exactly
 * this after the collapse, and it is the difference between paying full fan-out always and paying it
 * only when the cheap attempt failed.
 */
export const widen = (input: {
  readonly results: number
  readonly wanted: number
  readonly asked: number
  readonly available: number
}): number => {
  if (input.results >= input.wanted) return 0
  const remaining = Math.max(0, input.available - input.asked)
  // Double the reach rather than jumping to everyone: two more cheap waves beat one expensive one,
  // and a query that is going to be answered is usually answered early.
  return Math.min(remaining, input.asked === 0 ? FIRST_WAVE : input.asked)
}
