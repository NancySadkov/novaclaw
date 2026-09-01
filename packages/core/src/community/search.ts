export * as CommunitySearch from "./search"

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { CommunityChannels } from "./channels"
import { CommunityContacts } from "./contacts"
import { CommunityPeers } from "./peers"
import { CommunityReach } from "./reach"
import { CommunityWork } from "./work"
import { CommunityTopic } from "./topic"
import { askPeerJson, MAX_ANSWER_BYTES } from "./transport"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { InstanceIdentityStore } from "../instance-identity-store"
import { CommunityConsent } from "./consent"
import { Offline } from "../offline"

/**
 * Community P5 — throttled broadcast search (`notes/spec/community-p2p.md`).
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
  /**
   * Who CLAIMS to have asked — and the wording matters, because the first version of this comment
   * said "so results can be routed back" and nothing routes anything by it. Results return on the
   * HTTP response. Its only two uses are the own-query check and the throttle key.
   *
   * 🔴 **UNVERIFIED, and no security control may be built on it.** Unlike every other envelope here
   * it carries no signature, so one byte changed makes a different asker — demonstrated live: a
   * blocked origin and a one-character variant of it were both answered identically.
   *
   * ⚠️ This is why BLOCKING deliberately does not extend to search, though it covers rooms, direct
   * messages and offers. A block here would cost an attacker one string edit while showing the user
   * a protection that does not exist, and a false assurance is worse than an honest absence. What
   * makes that safe is the other half, pinned in `community-search-listed.test.ts`: a search can
   * only ever return rooms the user explicitly LISTED. **If that ever stops being true, this ruling
   * is void and search needs a signed origin.**
   */
  readonly origin: string
  /**
   * 🔴 Proof of work over `workBytes(query)`. Search was the ONE door in this design with no cost
   * attached, and the per-origin throttle was carrying that weight alone — which it cannot, because
   * `origin` is an unverified string the caller writes. Measured: 300,000 queries with a fresh
   * origin each were refused **0** times, while the same origin repeated 1,000 times was refused 990.
   * The control worked perfectly against an attacker who cooperated by not varying a string.
   *
   * ⚠️ `ttl` is deliberately NOT under the proof. It is decremented on every forward, so binding it
   * would invalidate the work at the first hop and make a search that only ever reaches its
   * neighbours. Everything that identifies the query IS bound, so a relay cannot re-point somebody
   * else's proven query at a different term or a different asker.
   */
  readonly nonce: number
}

/**
 * What the work is computed over: everything that IDENTIFIES a query, and nothing that travels.
 *
 * Newline-separated with the lengths implied by the field order rather than prefixed, because unlike
 * the message and offer envelopes these three fields cannot be shifted across each other: `id` is a
 * UUID of fixed shape and `origin` is a `nid_…` of fixed shape, so a character moved between them
 * changes both into something that no longer parses as either.
 */
export const workBytes = (query: Pick<Query, "id" | "terms" | "origin">): string =>
  `${query.id}
${query.terms}
${query.origin}`

export type Verdict =
  | { readonly forward: true; readonly next: Query }
  /** Named reasons, because "did not forward" with no cause is unreadable in a mesh. */
  | { readonly forward: false; readonly reason: "duplicate" | "expired" | "throttled" | "own-query" | "unproven" }

/**
 * Remembers query ids for a bounded time.
 *
 * ⚠️ Bounded, not permanent. A permanent set is a memory leak an attacker fills for free by sending
 * unique ids; forgetting after `SEEN_TTL_MS` costs at worst one extra forward of a very old query,
 * which its TTL then kills anyway.
 */
export class Seen {
  private readonly at = new Map<string, number>()

  constructor(
    private readonly ttlMs: number = SEEN_TTL_MS,
    /**
     * 🔴 A ceiling, because the TTL alone was never a bound. `prune` below is documented as "called
     * periodically" and **nothing ever called it** — so the only expiry was the lazy one in `has`,
     * which fires when an id is asked about AGAIN. A flooder never repeats an id (repeating is what
     * dedup catches), so their entries were precisely the ones nothing could reach.
     *
     * ⚠️ This is the same trap as peer eviction sorting by a `last_seen_at` nothing wrote: the
     * mechanism was present, correct, and unreachable. **A bound whose signal has no source is
     * decoration.** A ceiling needs no caller, which is why it is the belt rather than the braces.
     */
    private readonly maxIDs: number = 50_000,
  ) {}

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
    // Insertion order is eviction order, which for a rolling window is oldest-first.
    if (this.at.size > this.maxIDs) {
      const oldest = this.at.keys().next()
      if (!oldest.done) this.at.delete(oldest.value)
    }
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
    /**
     * ⚠️ A ceiling of OUR OWN on the map itself. Proof of work is what actually stops the flood now,
     * but this table is still keyed on a string the caller chose, and a defence that grows without
     * bound is the shape of half the findings in this subsystem. Insertion order is eviction order,
     * which for a rolling window is the same as oldest-first.
     */
    private readonly maxOrigins: number = 10_000,
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
    if (this.hits.size > this.maxOrigins) {
      const oldest = this.hits.keys().next()
      if (!oldest.done) this.hits.delete(oldest.value)
    }
    return true
  }

  /** How many origins are being tracked — so the ceiling above can be watched to hold. */
  get size(): number {
    return this.hits.size
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
  /**
   * 🔴 FIRST, before anything of ours is touched. An unproven query must not reach `seen.remember`
   * or the throttle's window — both are maps keyed on strings the caller chose, so letting an
   * unproven query write to either makes our own defences the flood's storage.
   *
   * One hash to check, ~49 ms to produce. That asymmetry is the only thing that makes a broadcast
   * search affordable to answer, and it is the same primitive every other door here already used.
   */
  if (!CommunityWork.verify(workBytes(query), query.nonce)) return { forward: false, reason: "unproven" }
  if (query.origin === context.self) return { forward: false, reason: "own-query" }
  if (context.seen.has(query.id, context.now)) return { forward: false, reason: "duplicate" }
  // Remember BEFORE the remaining checks: a query we refuse for TTL or throttle must still not be
  // reconsidered when the same id arrives from another neighbour a moment later.
  context.seen.remember(query.id, context.now)
  if (query.ttl <= 1) return { forward: false, reason: "expired" }
  if (!context.throttle.allow(query.origin, context.now)) return { forward: false, reason: "throttled" }
  /**
   * 🔴 CLAMPED to our own limit, because the hop count arrives INSIDE the query — written by whoever
   * sent it.
   *
   * Trusting it makes the hop limit bind honest senders only: a peer that writes `ttl: 1_000_000`
   * reaches every instance it can transitively touch instead of a four-hop neighbourhood. Duplicate
   * suppression keeps each node from forwarding twice, so this is not the exponential re-broadcast
   * that killed Gnutella — it is the other half of that failure, one cheap query conscripting the
   * whole network, repeatable at whatever rate the per-origin throttle allows.
   *
   * ⚠️ `min`, not a rewrite: a query that arrives with a SHORTER hop count keeps it. A sender may ask
   * for less reach than we would grant; they may not ask for more.
   */
  return { forward: true, next: { ...query, ttl: Math.min(query.ttl, DEFAULT_TTL) - 1 } }
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

/**
 * ⚠️ Peers asked simultaneously within one wave. `widen` doubles the wave size, so a late wave over a
 * full peer table would otherwise open hundreds of sockets at once — and a forwarding node does this
 * on somebody ELSE'S query, so the storm would not even be its own user's doing.
 */
const FANOUT = 8

/** How many answers are enough to stop widening. Beyond this, more peers cost traffic for nothing. */
export const WANTED = 8

/**
 * 🔴 The most peers ONE query may ask, however little it finds.
 *
 * Widening stops when enough answers arrive — but a search that finds NOTHING is the common case for
 * a specific term, and without this it walked the entire peer table. At the table's legitimate bound
 * that is 500 outbound requests for one query, and a FORWARDING node pays it too, on somebody else's
 * query. The per-origin throttle bounds how many queries an origin may send; it says nothing about
 * what each one costs, so ten queries became five thousand requests.
 *
 * ⚠️ This is Gnutella's collapse arriving by BREADTH rather than depth, which is why the hop limit
 * alone did not stop it. Asking 32 peers and reporting what they knew is a search; asking 500 is a
 * broadcast storm wearing a search's name.
 */
export const MAX_ASKED = 32

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

/**
 * The most rooms one peer may name in a single search answer.
 *
 * ⚠️ `MAX_ASKED` bounds how many peers a search reaches; nothing bounded what each one returns, so
 * the total was `peers × whatever they said`. A size limit is not a count limit.
 */
const MAX_CHANNELS_PER_ANSWER = 200

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service
    // 🔴 `speaks()` rather than the airgap alone: an instance that has not JOINED must not reach out
    // either. Gating only the inbound door was the first attempt and it left the bigger half open —
    // outbound connections are precisely what reveal the user's IP to a stranger, which is the thing
    // the warning they accepted is about. `participates` covers BOTH conditions, and reads each live.
    const speaks = () => CommunityConsent.participates(CommunityConsent.currentGate())
    const channels = yield* CommunityChannels.Service
    const peers = yield* CommunityPeers.Service
    const contacts = yield* CommunityContacts.Service
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

    /**
     * 🔴 Contacts AND peers, through the shared builder (review 1.14, 1.9).
     *
     * This read `peers.list()` ONLY, so search never asked the people the user had actually added:
     * `contactAdd` writes the contacts table, and a fresh install whose one entry point is a
     * hand-added contact got empty results until peer exchange happened to return that peer. It
     * dialled the untrusted table and skipped the trusted one — and, through the same omission,
     * dialled peers the user had BLOCKED.
     */
    const routes = Effect.fn("CommunitySearch.routes")(function* () {
      return (yield* CommunityReach.reachable({ contacts, peers })).map((entry) => entry.route)
    })

    const askPeer = (route: string, query: Query) =>
      askPeerJson({
        http,
        route,
        path: SEARCH_PATH,
        body: query,
        schema: Answer,
        timeoutMs: FORWARD_TIMEOUT_MS,
        /**
         * 🔴 **The ceiling this file was missing.** It used to call `answerTooLarge(headers)` with no
         * argument, taking the 4 MB `sync/messages` default — five hundred times what this route can
         * honestly return. A search answer is a few hundred channel NAMES, so it is bounded by the
         * answer-shaped limit, not by a page of messages. The dial itself now lives in
         * `transport.ts` precisely so the next tuning cannot reach one caller and miss the other.
         */
        ceilingBytes: MAX_ANSWER_BYTES,
      }).pipe(
        /**
         * ⚠️ And a COUNT ceiling, which bytes do not give: every name here joins a Set that this
         * returns to the app and to the agent tool, and `MAX_ASKED` bounds how many PEERS answer,
         * never how much each one says. A peer hosting more rooms than this is not a case that
         * exists — `channelsNearby` uses the same number for the same reason. It stays HERE, not in
         * the shared dial, because it is a fact about channels rather than about peers.
         */
        Effect.map((answer) => (answer === undefined ? [] : [...answer.channels].slice(0, MAX_CHANNELS_PER_ANSWER))),
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
        if (asked >= MAX_ASKED) break
        const more = widen({ results: found.size, wanted: WANTED, asked, available: available.length })
        if (more === 0) break
        // ⚠️ The wave is clipped to the remaining budget, so the cap holds even mid-doubling — widen
        // returns the size it WANTS, and the last one it wants is usually larger than what is left.
        const wave = available.slice(asked, Math.min(asked + more, MAX_ASKED))
        if (wave.length === 0) break
        const answers = yield* Effect.all(
          wave.map((route) => askPeer(route, query)),
          { concurrency: FANOUT },
        )
        for (const names of answers) for (const name of names) found.add(name)
        asked += wave.length
      }
      return [...found]
    })

    return Service.of({
      search: Effect.fn("CommunitySearch.search")(function* (terms: string) {
        if (!speaks()) return []
        const self = (yield* identity.identity()).networkID
        /**
         * ⚠️ A fresh id per search, and it is the DEDUP key every node keys on. Reusing one would
         * make every node treat the second search as a duplicate of the first and answer nothing —
         * a search that silently stops working after it has been run once.
         */
        const unproven = { id: randomUUID(), terms, ttl: DEFAULT_TTL, origin: self }
        /**
         * ⚠️ The asker pays for their own search — about 49 ms, once, however far it travels. The
         * proof rides along unchanged through every forward because `ttl` is outside it, so a single
         * solve buys the whole broadcast for the person who wanted it, and costs a flooder the same
         * 49 ms for every distinct query they invent.
         */
        const nonce = CommunityWork.solve(workBytes(unproven))
        // A machine that cannot find the work reports an empty search rather than sending something
        // every peer will refuse — the difficulty is a probability, not a promise.
        if (nonce === undefined) return []
        const remote = yield* broadcast({ ...unproven, nonce })
        // Our own listed channels are not a search RESULT: the user already has them.
        const mine = new Set((yield* channels.channels()).map((entry) => CommunityTopic.canonical(entry.name)))
        return remote.filter((name) => !mine.has(CommunityTopic.canonical(name)))
      }),

      receive: Effect.fn("CommunitySearch.receive")(function* (query: Query) {
        if (!speaks()) return []
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
  deps: [
    Offline.node,
    CommunityChannels.node,
    CommunityContacts.node,
    CommunityPeers.node,
    InstanceIdentityStore.node,
    httpClient,
  ],
})
