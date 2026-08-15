export * as CommunitySync from "./sync"

import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { CommunityChannels } from "./channels"
import { CommunityContacts } from "./contacts"
import { CommunityMessage } from "./message"
import { CommunityReconcile } from "./reconcile"
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
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunitySync") {}

/** What a peer sends back. Parsed rather than trusted: a peer is an untrusted source of bytes. */
const Summary = Schema.Struct({ buckets: Schema.Array(Schema.String) })
const Ids = Schema.Struct({ ids: Schema.Array(Schema.String) })
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

const PER_REQUEST_TIMEOUT_MS = 10_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service
    const contacts = yield* CommunityContacts.Service
    const channels = yield* CommunityChannels.Service
    const http = yield* HttpClient.HttpClient

    /**
     * One POST to a peer, decoded into `schema`, or `undefined`.
     *
     * ⚠️ Total by construction. A peer that is offline, slow, running a different version or
     * answering with nonsense is the ORDINARY case in a network of home machines — none of it is an
     * error the user should see, and none of it may abort a sync with the peers that did answer.
     */
    const ask = <A, I>(route: string, path: string, body: unknown, schema: Schema.Codec<A, I>) =>
      http
        .execute(
          HttpClientRequest.post(`${route.replace(/\/+$/, "")}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        )
        .pipe(
          Effect.timeout(PER_REQUEST_TIMEOUT_MS),
          Effect.flatMap((response) => response.json),
          Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json)),
          Effect.map((value): A | undefined => value),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )

    return Service.of({
      sync: Effect.fn("CommunitySync.sync")(function* (channel: string) {
        // The airgap gate, first and by the same argument as the transport's: a community is egress
        // the user chose, and airgap has to be able to withdraw that choice.
        if (offline.policy.enabled) return { peers: 0, fetched: 0 }

        const known = yield* contacts.bootstrap()
        const peers = known.flatMap((contact) => httpRoutes(contact.routes))
        if (peers.length === 0) return { peers: 0, fetched: 0 }

        const topic = CommunityTopic.topicOf(channel)
        let answered = 0
        let fetched = 0

        for (const route of peers) {
          const mine = yield* channels.ids(channel)
          const theirs = yield* ask(route, SYNC_SUMMARY_PATH, { topic }, Summary)
          if (theirs === undefined) continue
          answered++

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
  deps: [Offline.node, CommunityContacts.node, CommunityChannels.node, httpClient],
})
