export * as CommunitySync from "./sync"

import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { CommunityChannels } from "./channels"
import { CommunityContacts } from "./contacts"
import { CommunityMessage } from "./message"
import { CommunityPeers } from "./peers"
import { CommunityReconcile } from "./reconcile"
import { CommunitySuccession } from "./succession"
import { CommunityTopic } from "./topic"
import { httpRoutes } from "./transport"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { Offline } from "../offline"

/**
 * Community P4 — catching up on what was said while you were away.
 *
 * 🔴 The half the transport does not provide, and the largest design risk in the program. Delivery
 * reaches whoever is ONLINE; an instance that was closed for a day misses that day permanently. A
 * forum whose messages vanish for anyone who was away is not a forum, and every instance keeping its
 * own log only makes it a partial archive if two instances can work out what the other is missing.
 *
 * `reconcile.ts` is the algorithm and has been sitting unused since it was written. This is the wire:
 * a three-step exchange whose cost tracks the DIFFERENCE rather than the log size.
 *
 *   1. ask a peer for its 64 bucket digests (~4 KB, whatever the log holds)
 *   2. for buckets that differ, ask for that bucket's ids
 *   3. ask for the messages we do not have — and put every one through `deliver`
 *
 * ⚠️ Step 3 is not an optimisation, it is the security boundary: fetched messages enter through the
 * ONE ingress door, so a peer answering a sync gets no more trust than a stranger pushing a message.
 * Signature, work, subscription, block, size and duplicate rules all apply exactly as they do on the
 * open door. A sync that inserted rows directly would be a second door with none of them, and it
 * would be the easiest one to attack because we asked for the data.
 */

/** Paths a peer serves so others can catch up from it. */
export const SYNC_SUMMARY_PATH = "/api/community/sync/summary"
export const SYNC_IDS_PATH = "/api/community/sync/ids"
export const SYNC_MESSAGES_PATH = "/api/community/sync/messages"
/** Peer exchange — how one address becomes an entry point to the whole network. */
export const PEERS_PATH = "/api/community/peers"
/** Channel discovery — what each peer chose to disclose, never what it is actually in. */
export const LISTED_PATH = "/api/community/listed"
/** Successor statements — told to peers on rotation, and asked for by peers that were away. */
export const SUCCESSION_PATH = "/api/community/succession"

/**
 * The most messages one request may ask for.
 *
 * ⚠️ A bound on what a PEER can make us assemble, not a preference. Without it a single request could
 * name all 5,000 retained ids and have us build the response in memory — cheap for them, expensive
 * for us, and repeatable. A sync simply takes more rounds; each round still makes progress.
 */
export const MAX_MESSAGES_PER_REQUEST = 256

export interface Result {
  /** Peers that answered, whether or not they had anything we lacked. */
  readonly peers: number
  /** Messages that ENTERED the log — already past the ingress door, so this is a true count. */
  readonly fetched: number
}

export interface Interface {
  /** Reconcile one channel against every reachable peer. */
  readonly sync: (channel: string) => Effect.Effect<Result>
  /**
   * Ask reachable peers who else they know, and remember the answers.
   *
   * 🔴 This is the anti-shutdown property in motion. The spec: *any peer address from any source is
   * a complete entry point, because peer exchange supplies the rest.* One contact, one pasted
   * address or one instance on the LAN is therefore enough to reach a network nobody can switch off
   * — there is no list to seize because nothing is special about any particular entry.
   *
   * ⚠️ What it learns are ROUTES, and they land in the peer table, never the address book. A peer
   * that can talk to us must not be able to make itself a CONTACT: that is a trust decision the
   * user makes, and `observe`/`follow` already refuse it for the same reason.
   */
  readonly discover: () => Effect.Effect<{ readonly asked: number; readonly learned: number }>
  /**
   * Learn peers from ADDRESSES ALONE — a LAN sighting, or an address the user pasted.
   *
   * 🔴 Principle 12: a setting may never require a value the user has no way to know. Adding a peer
   * used to mean typing a 47-character `nid_…` key, which is not a thing anyone can read off a
   * screen and retype — while the instance at that address will simply TELL us its key if asked.
   * So the address is the input and the identity is discovered, never demanded.
   *
   * ⚠️ It also verifies: an address that does not answer as a NovaClaw instance teaches us nothing
   * and is not stored. A route that was never going to work is worse than no route, because it looks
   * like a peer that is merely offline.
   */
  readonly learnFrom: (addresses: readonly string[], source?: string) => Effect.Effect<number>
  /**
   * Channels our peers advertise, minus the ones we are already in.
   *
   * ⚠️ ONE HOP, and named that way rather than called "search". A multi-hop throttled broadcast is
   * what `search.ts` is for and is a bigger thing; this asks the instances we can already reach. It
   * is honest about its reach instead of implying the whole network answered.
   */
  readonly channelsNearby: () => Effect.Effect<ReadonlyArray<string>>
  /**
   * Tell every reachable peer that a key rotated, and collect the rotations they know.
   *
   * 🔴 Both directions, and the second is the one that makes rotation survivable. Pushing reaches
   * whoever is online at that moment — in a network of home machines, that is a minority. Asking is
   * how an instance that was CLOSED when someone rotated still finds them, instead of holding an
   * identity that answers nothing forever.
   *
   * ⚠️ Statements are self-verifying, so both directions are safe with strangers: `remember` refuses
   * a forgery before storing it, and `followAll` moves only contacts whose whole chain is proven.
   */
  readonly successions: (
    announce?: CommunitySuccession.Statement,
  ) => Effect.Effect<{ readonly told: number; readonly learned: number }>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunitySync") {}

/** What a peer sends back. Parsed rather than trusted: a peer is an untrusted source of bytes. */
const Summary = Schema.Struct({ buckets: Schema.Array(Schema.String) })
const Ids = Schema.Struct({ ids: Schema.Array(Schema.String) })
/** Enough of `/global/health` to identify a peer. Every instance already serves it. */
const Health = Schema.Struct({ networkID: Schema.String })
const Listed = Schema.Struct({ channels: Schema.Array(Schema.String) })
const Successions = Schema.Struct({
  statements: Schema.Array(
    Schema.Struct({
      predecessor: Schema.String,
      successor: Schema.String,
      at: Schema.Number,
      signature: Schema.String,
    }),
  ),
})

const PeerList = Schema.Struct({
  peers: Schema.Array(Schema.Struct({ networkID: Schema.String, routes: Schema.Array(Schema.String) })),
})
const Messages = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      channel: Schema.String,
      author: Schema.String,
      at: Schema.Number,
      body: Schema.String,
      signature: Schema.String,
      nonce: Schema.Number,
    }),
  ),
})

const Ack = Schema.Struct({ received: Schema.Boolean })

const PER_REQUEST_TIMEOUT_MS = 10_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service
    const contacts = yield* CommunityContacts.Service
    const channels = yield* CommunityChannels.Service
    const peers = yield* CommunityPeers.Service
    const successions = yield* CommunitySuccession.Store
    const http = yield* HttpClient.HttpClient

    /**
     * One POST to a peer, decoded into `schema`, or `undefined`.
     *
     * ⚠️ Total by construction. A peer that is offline, slow, running a different version or
     * answering with nonsense is the ORDINARY case in a network of home machines — none of it is an
     * error the user should see, and none of it may abort a sync with the peers that did answer.
     */
    const ask = <A, I>(
      route: string,
      path: string,
      body: unknown,
      schema: Schema.Codec<A, I>,
      method: "POST" | "GET" = "POST",
    ) =>
      http
        .execute(
          method === "GET"
            ? HttpClientRequest.get(`${route.replace(/\/+$/, "")}${path}`)
            : HttpClientRequest.post(`${route.replace(/\/+$/, "")}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        )
        .pipe(
          Effect.timeout(PER_REQUEST_TIMEOUT_MS),
          Effect.flatMap((response) => response.json),
          Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json)),
          Effect.map((value): A | undefined => value),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )

    /**
     * Everywhere we might reach the network: trusted contacts AND merely-known routes.
     *
     * ⚠️ Carries the IDENTITY beside each route, which an earlier version dropped by flattening to a
     * list of URLs. That loss was not cosmetic: eviction from the peer table is least-recently-SEEN
     * first, so without knowing whose route just answered there is nothing to mark, `last_seen_at`
     * stays null forever, and a flood of invented peers evicts the ones that actually work. The bound
     * would still be there and would be useless. The orphan ledger found it — `seen` had no caller.
     */
    const reachable = Effect.gen(function* () {
      const known = yield* contacts.bootstrap()
      const learned = yield* peers.list()
      const out: { networkID: string; route: string }[] = []
      const already = new Set<string>()
      for (const entry of [...known, ...learned])
        for (const route of httpRoutes(entry.routes))
          if (!already.has(route)) {
            already.add(route)
            out.push({ networkID: entry.networkID, route })
          }
      return out
    })

    return Service.of({
      successions: Effect.fn("CommunitySync.successions")(function* (announce) {
        if (offline.policy.enabled) return { told: 0, learned: 0 }
        let told = 0
        let learned = 0
        for (const peer of yield* reachable) {
          if (announce !== undefined) {
            const ack = yield* ask(peer.route, SUCCESSION_PATH, announce, Ack, "POST")
            if (ack !== undefined) told++
          }
          const theirs = yield* ask(peer.route, SUCCESSION_PATH, undefined, Successions, "GET")
          if (theirs === undefined) continue
          yield* peers.seen(peer.networkID)
          for (const statement of theirs.statements) if (yield* successions.remember(statement)) learned++
          // ⚠️ `followAll` and not a loop of `follow`: statements arrive from a mesh in no order, and
          // single-stepping drops a link whose predecessor has not been seen yet and never retries.
          yield* contacts.followAll([...theirs.statements])
        }
        return { told, learned }
      }),

      channelsNearby: Effect.fn("CommunitySync.channelsNearby")(function* () {
        if (offline.policy.enabled) return []
        const joined = (yield* channels.channels()).map((entry) => CommunityTopic.canonical(entry.name))
        const seen = new Map<string, string>()
        for (const peer of yield* reachable) {
          const answer = yield* ask(peer.route, LISTED_PATH, undefined, Listed, "GET")
          if (answer === undefined) continue
          yield* peers.seen(peer.networkID)
          for (const name of answer.channels) {
            // ⚠️ Keyed CANONICALLY, so two peers spelling one room differently offer it once — the
            // same rule that stops a second spelling becoming a second room locally.
            const key = CommunityTopic.canonical(name)
            if (joined.includes(key) || seen.has(key)) continue
            seen.set(key, name)
          }
        }
        return [...seen.values()]
      }),

      learnFrom: Effect.fn("CommunitySync.learnFrom")(function* (addresses, source = "lan") {
        if (offline.policy.enabled) return 0
        let learned = 0
        for (const address of httpRoutes(addresses)) {
          // ⚠️ ASK who they are rather than trusting a claim attached to the address. The reply is
          // only a claim too — anyone can serve a health endpoint — but a peer's key is not a secret
          // and every message it sends is verified against it anyway. What this buys is that the
          // route is real and reaches something that speaks our protocol.
          const health = yield* ask(address, "/global/health", undefined, Health, "GET")
          if (health === undefined) continue
          if (yield* peers.learn(health.networkID, [address], source)) learned++
        }
        return learned
      }),

      discover: Effect.fn("CommunitySync.discover")(function* () {
        if (offline.policy.enabled) return { asked: 0, learned: 0 }
        let asked = 0
        let learned = 0
        for (const peer of yield* reachable) {
          const answer = yield* ask(peer.route, PEERS_PATH, undefined, PeerList, "GET")
          if (answer === undefined) continue
          asked++
          // It answered, so it is alive: this is what keeps a working peer ahead of invented ones
          // when the table is evicted.
          yield* peers.seen(peer.networkID)
          for (const peer of answer.peers) {
            // ⚠️ `learn` does the refusing — our own key, and anything that is not a public key. A
            // peer describing peers is hearsay, so every claim is filtered by the store rather than
            // trusted because it arrived over a connection that worked.
            if (yield* peers.learn(peer.networkID, [...peer.routes], "px")) learned++
          }
        }
        return { asked, learned }
      }),

      sync: Effect.fn("CommunitySync.sync")(function* (channel: string) {
        // The airgap gate, first and by the same argument as the transport's: a community is egress
        // the user chose, and airgap has to be able to withdraw that choice.
        if (offline.policy.enabled) return { peers: 0, fetched: 0 }

        // 🔴 Contacts AND learned peers. Syncing only with people the user added by hand would make
        // catching up depend on who they happen to know, when the whole point of peer exchange is
        // that any entry point reaches the network.
        const dialable = yield* reachable
        if (dialable.length === 0) return { peers: 0, fetched: 0 }

        const topic = CommunityTopic.topicOf(channel)
        let answered = 0
        let fetched = 0

        for (const { networkID, route } of dialable) {
          const mine = yield* channels.ids(channel)
          const theirs = yield* ask(route, SYNC_SUMMARY_PATH, { topic }, Summary)
          if (theirs === undefined) continue
          answered++
          yield* peers.seen(networkID)

          const disagree = CommunityReconcile.differing(
            CommunityReconcile.summarize(mine),
            [...theirs.buckets],
          )
          if (disagree.length === 0) continue

          const offered = yield* ask(route, SYNC_IDS_PATH, { topic, buckets: disagree }, Ids)
          if (offered === undefined) continue

          // What we do not hold. `missing` deliberately returns what to REQUEST, so nothing arrives
          // because a sender decided it should — the same rule the ingress door enforces.
          const wanted = CommunityReconcile.missing([...offered.ids], mine)
          for (let index = 0; index < wanted.length; index += MAX_MESSAGES_PER_REQUEST) {
            const batch = wanted.slice(index, index + MAX_MESSAGES_PER_REQUEST)
            const carried = yield* ask(route, SYNC_MESSAGES_PATH, { topic, ids: batch }, Messages)
            if (carried === undefined) break
            for (const message of carried.messages) {
              // 🔴 THE ingress door. A peer we asked gets no more trust than a stranger who pushed.
              const result = yield* channels.deliver(topic, message as CommunityMessage.Proven)
              if ("stored" in result) fetched++
            }
          }
        }

        return { peers: answered, fetched }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Offline.node,
    CommunityContacts.node,
    CommunityChannels.node,
    CommunityPeers.node,
    CommunitySuccession.node,
    httpClient,
  ],
})
