export * as CommunitySearch from "./search"

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { CommunityChannels } from "./channels"
import { CommunityPeers } from "./peers"
import { CommunityTopic } from "./topic"
import { httpRoutes } from "./transport"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { InstanceIdentityStore } from "../instance-identity-store"
import { Offline } from "../offline"

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

/** Where a node accepts a broadcast query. */
export const SEARCH_PATH = "/api/community/search"

/**
 * A forward waits far less than an ordinary request. A query fans out through several hops, so the
 * originator pays the SUM of the slowest chain — a peer that is merely slow must cost a moment, not
 * the whole search.
 */
const FORWARD_TIMEOUT_MS = 4_000

/** How many answers are enough to stop widening. Beyond this, more peers cost traffic for nothing. */
export const WANTED = 8

export interface Interface {
  /** Ask the network. Starts narrow and widens only if the cheap attempt under-delivers. */
  readonly search: (terms: string) => Effect.Effect<ReadonlyArray<string>>
  /**
   * A query arrived from a peer: answer it, and pass it on if the controls allow.
   *
   * 🔴 This is where Gnutella's collapse is prevented. `consider` applies all three controls before
   * anything is forwarded — identity, duplicate-by-id, TTL, then the per-ORIGIN throttle — and a
   * refusal is silent to the caller, since telling a flooder which control stopped it is telling it
   * what to vary.
   */
  readonly receive: (query: Query) => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunitySearch") {}

const Answer = Schema.Struct({ channels: Schema.Array(Schema.String) })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service
    const channels = yield* CommunityChannels.Service
    const peers = yield* CommunityPeers.Service
    const identity = yield* InstanceIdentityStore.Service
    const http = yield* HttpClient.HttpClient

    /**
     * ⚠️ ONE `Seen` and ONE `Throttle` for the whole instance, held here rather than made per call.
     * Duplicate suppression and a rolling rate window are only meaningful across queries — rebuilt
     * per request they would forget everything they exist to remember, and the controls would read
     * as present while doing nothing.
     */
    const seen = new Seen()
    const throttle = new Throttle()

    /** Our LISTED channels matching the terms — never the ones the user kept private. */
    const matches = Effect.fn("CommunitySearch.matches")(function* (terms: string) {
      const wanted = CommunityTopic.canonical(terms)
      if (wanted === "") return []
      const advertised = yield* channels.listed()
      return advertised.filter((name) => CommunityTopic.canonical(name).includes(wanted))
    })

    const routes = Effect.fn("CommunitySearch.routes")(function* () {
      return (yield* peers.list()).flatMap((peer) => httpRoutes(peer.routes))
    })

    const askPeer = (route: string, query: Query) =>
      http
        .execute(
          HttpClientRequest.post(`${route.replace(/\/+$/, "")}${SEARCH_PATH}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(query),
          ),
        )
        .pipe(
          Effect.timeout(FORWARD_TIMEOUT_MS),
          Effect.flatMap((response) => response.json),
          Effect.flatMap((json) => Schema.decodeUnknownEffect(Answer)(json)),
          Effect.map((answer) => [...answer.channels]),
          // A peer that is offline, slow or speaking a different version is the ordinary case, and
          // none of it may abort a search that other peers are answering.
          Effect.catchCause(() => Effect.succeed([] as string[])),
        )

    /**
     * Ask peers in WAVES, widening only when a wave under-delivers.
     *
     * 🔴 The difference between paying full fan-out always and paying it only when the cheap attempt
     * failed — the fix Gnutella 0.6 added after the collapse. A query that is going to be answered is
     * usually answered by the first few peers.
     */
    const broadcast = Effect.fn("CommunitySearch.broadcast")(function* (query: Query) {
      const available = yield* routes()
      const found = new Set<string>()
      let asked = 0
      for (;;) {
        const more = widen({ results: found.size, wanted: WANTED, asked, available: available.length })
        if (more === 0) break
        const wave = available.slice(asked, asked + more)
        if (wave.length === 0) break
        const answers = yield* Effect.all(
          wave.map((route) => askPeer(route, query)),
          { concurrency: "unbounded" },
        )
        for (const names of answers) for (const name of names) found.add(name)
        asked += wave.length
      }
      return [...found]
    })

    return Service.of({
      search: Effect.fn("CommunitySearch.search")(function* (terms: string) {
        if (offline.policy.enabled) return []
        const self = (yield* identity.identity()).networkID
        /**
         * ⚠️ A fresh id per search, and it is the DEDUP key every node keys on. Reusing one would
         * make every node treat the second search as a duplicate of the first and answer nothing —
         * a search that silently stops working after it has been run once.
         */
        const query: Query = { id: randomUUID(), terms, ttl: DEFAULT_TTL, origin: self }
        const remote = yield* broadcast(query)
        // Our own listed channels are not a search RESULT: the user already has them.
        const mine = new Set((yield* channels.channels()).map((entry) => CommunityTopic.canonical(entry.name)))
        return remote.filter((name) => !mine.has(CommunityTopic.canonical(name)))
      }),

      receive: Effect.fn("CommunitySearch.receive")(function* (query: Query) {
        if (offline.policy.enabled) return []
        const self = (yield* identity.identity()).networkID
        const verdict = consider(query, { self, seen, throttle, now: Date.now() })
        // Answer from our own shelf whatever the verdict: refusing to FORWARD a query is a traffic
        // decision, and it should not also cost the asker the answer we already had.
        const local = yield* matches(query.terms)
        if (!verdict.forward) return local
        const onward = yield* broadcast(verdict.next)
        return [...new Set([...local, ...onward])]
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Offline.node, CommunityChannels.node, CommunityPeers.node, InstanceIdentityStore.node, httpClient],
})
