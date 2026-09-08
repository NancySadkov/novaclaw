export * as CommunitySync from "./sync"

import { randomBytes } from "node:crypto"

import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { CommunityChannels } from "./channels"
import { CommunityContacts } from "./contacts"
import { CommunityDirect } from "./dm"
import { CommunityMessage } from "./message"
import { CommunityObservation } from "./observation"
import { CommunityOffer } from "./offer"
import { CommunityPeers } from "./peers"
import { CommunityReach } from "./reach"
import { CommunityRoute } from "./route"
import { CommunityReconcile } from "./reconcile"
import { CommunitySuccession } from "./succession"
import { CommunityTopic } from "./topic"
import { askPeerJson, MAX_ANSWER_BYTES, MAX_PEER_RESPONSE_BYTES, typedRoutes } from "./transport"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { InstanceIdentityStore } from "../instance-identity-store"
import { CommunityAnswer } from "./answer"
import { CommunityConsent } from "./consent"
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

/**
 * How long after catching up on a channel before it is worth asking again.
 *
 * ⚠️ Tuned to what it PROTECTS, not to a feel: a catch-up is one round trip per peer imposed on
 * other people's machines, and the events that trigger it — a user switching channels, a model
 * calling `history` — repeat far faster than a room's contents change. Thirty seconds is long
 * enough that a loop cannot turn into a flood and short enough that nobody reading a live
 * conversation notices it, since delivery already pushes new messages as they are said. Catch-up
 * fills the gap left by being AWAY; it is not how a channel stays current while you watch it.
 */
export const SYNC_COOLDOWN_MS = 30_000

/**
 * How long before the SAME question may be put to the SAME peer again.
 *
 * 🔴 The new-peer-door checklist's outbound rule 10: *"add a cooldown if the call can repeat"*. An
 * ask repeats trivially — the permission is granted per peer and saved, so an "always" answer makes
 * every later ask free from the user's side, and a model loop repeats in milliseconds.
 *
 * ⚠️ Tuned to what it PROTECTS, and that is somebody else's machine: an ask is a MODEL TURN on
 * their hardware, not the round trip `SYNC_COOLDOWN_MS` guards. Their per-asker budget defaults to
 * FIVE A DAY, so a loop that fires the same question in one burst spends their whole allowance on
 * one repeated sentence and leaves nothing for a question that mattered.
 *
 * ⚠️ Keyed on peer AND question, deliberately. A follow-up is legitimate and often immediate — an
 * agent reads an answer and asks the obvious next thing — so a per-peer window would punish exactly
 * the conversation this feature exists to have. An IDENTICAL repeat is always pathological.
 *
 * ⚠️ And it is honest about what it does not stop: a loop that varies its wording walks straight
 * through. The bound that does not depend on our politeness is the peer's own budget, which is why
 * that was built first.
 */
export const ASK_COOLDOWN_MS = 60_000

/**
 * The most channels whose last-sync time is remembered.
 *
 * ⚠️ A ceiling rather than an expiry sweep, for the reason `search.ts` records one file over: a
 * bound whose signal has no source is decoration. `sync` accepts any channel name from the tool or
 * the route, so without this an agent asking about a million invented rooms would grow this map
 * forever — and forgetting a stale entry costs one extra catch-up, which is the cheap direction.
 */
const MAX_SYNC_STAMPS = 10_000

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
/** Where a peer accepts a direct message. */
export const DM_PATH = "/api/community/dm"

/** Where a peer answers questions. The other half of `communityAsk`, which had no caller until now. */
export const ASK_PATH = "/api/community/ask"
/** What a peer offers — collected while discovering, since it is the same round of asking. */
export const OFFER_PATH = "/api/community/offer"

/**
 * The most messages one request may ask for.
 *
 * ⚠️ A bound on what a PEER can make us assemble, not a preference. Without it a single request could
 * name all 5,000 retained ids and have us build the response in memory — cheap for them, expensive
 * for us, and repeatable. A sync simply takes more rounds; each round still makes progress.
 */
/**
 * How many distinct peers ONE sync operation may reach out to.
 *
 * 16, against `search`'s 32: search is concurrent and its cost is other people's throttle budget,
 * while these loops are sequential and their cost is the user waiting. Sixteen unreachable peers at
 * the 10 s timeout is about two and a half minutes — bad, but bounded and survivable, where 500 is
 * not.
 *
 * ⚠️ That upper bound is survivable only where somebody can SEE it. The two callers wired since
 * treat it accordingly: the community panel does not await catch-up before drawing, and the agent
 * tool caps its wait and answers from what it holds.
 */
export const MAX_PEERS_ASKED = 16

/**
 * The most addresses kept on ONE contact.
 *
 * ⚠️ A ceiling because the list grows from what we successfully DIALLED, and the routes we dial come
 * from the peer table, which peers themselves fill. A contact answering on many ports would
 * otherwise accumulate a row without limit — the same "a value a stranger wrote became our row"
 * shape this subsystem bounds everywhere else. Six is well past the real case (a LAN address, a
 * public one, maybe a relay) and far below anything worth an attack.
 */
export const MAX_CONTACT_ROUTES = 6

/**
 * 🔴 Ceilings on how many ITEMS a peer's answer may contain.
 *
 * The 4 MB response cap bounds the BYTES that arrive; it does not bound the count, and every one of
 * these arrays feeds a loop that does real work per element — a signature verification, a database
 * write, a delivery. **A size limit is not a count limit**, which is the lesson the peer-route cap
 * had already taught on the same day, one file over.
 *
 * ⚠️ Derived where a derivation exists rather than picked. `sync/messages` is the strict case: we
 * asked for at most `MAX_MESSAGES_PER_REQUEST` ids, so anything beyond that many messages is
 * definitionally invented and there is no honest answer that needs it. The others are generous
 * against any real instance — a peer hosting more than 200 rooms, offering more than 128 peers in
 * one breath, or holding more than 64 succession statements is not a case that exists.
 */
export const MAX_LISTED_PER_ANSWER = 200
export const MAX_PEERS_PER_ANSWER = 128
export const MAX_SUCCESSIONS_PER_ANSWER = 64

// The peer-answer ceiling lives in `transport.ts` — one rule for every module that dials a peer.
// It was declared here first and `search.ts` never got it, which is the per-caller mistake again.

export const MAX_MESSAGES_PER_REQUEST = 256

/**
 * How many reconciliation buckets one `/sync/ids` request names.
 *
 * 🔴 It exists because the ANSWERER caps its reply (`CommunityReconcile.MAX_IDS_PER_ANSWER`), and a
 * truncated reply is not self-correcting: re-asking for the same buckets returns the same first N
 * ids forever. Chunking makes every answer COMPLETE for the buckets it covers, which is the only
 * shape in which a cap and convergence coexist.
 */
export const BUCKETS_PER_REQUEST = 8

/**
 * 🔴 **The whole of one catch-up, however many peers answer** — review §2 (unit 3 F6).
 *
 * `sync` walked up to `MAX_PEERS_ASKED` peers, each costing a summary, up to eight id requests and
 * up to twenty message batches at a 10 s timeout apiece. Nothing bounded the total, so one call
 * could run for the better part of an hour — and the tool that drives it gives up after 5 s, so the
 * work past that point is spent on a caller who has already stopped listening.
 *
 * ⚠️ A budget rather than a smaller per-peer timeout: a slow honest peer and a hundred dead ones are
 * different problems, and only the total is a number a user can feel.
 */
export const SYNC_TOTAL_MS = 20_000

/**
 * 🔴 How long a route that just failed is skipped for — the fix for DETERMINISTIC starvation.
 *
 * `reachable` is stably ordered with contacts first, so a dead first contact was dialled first every
 * time. With a per-peer timeout of seconds and a caller that waits 5 s, catch-up never reached the
 * second peer — the same peer, the same failure, forever, and no amount of retrying changed the
 * order. Remembering a failure for a minute lets the NEXT attempt start where the last one stopped.
 *
 * ⚠️ Short on purpose. This is a scheduling hint, not a health verdict: a peer that was asleep for
 * one dial must not be written off, and the peer table's own `last_seen_at` is what tracks lasting
 * absence.
 */
export const ROUTE_COOLDOWN_MS = 60_000

/**
 * 🔴 The ceiling on a SMALL read — review §2 (unit 3 F9): the per-shape ceilings were applied to
 * `ask` and nothing else, so every other route accepted 4 MB, a number derived from a page of 256
 * messages. An identity probe, a peer list, a room list, an offer and a summary are all kilobytes;
 * accepting four megabytes of one is accepting 4,000× what it can honestly be.
 */
export const MAX_SMALL_RESPONSE_BYTES = 256 * 1024


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
  /** Ask an address who lives there. `undefined` when nothing answers, or the community is off. */
  readonly identify: (
    address: string,
  ) => Effect.Effect<{ readonly networkID: string; readonly route: string } | undefined>
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
  /**
   * Send a direct message to `to`.
   *
   * 🔴 Fetches the recipient's SEALING key from their own instance and verifies it against their
   * identity before sealing. Taking that key from anywhere else — a contact record, a cache, a peer
   * that offered it — is the substitution attack: the sender succeeds, the ciphertext is valid, and
   * the only evidence is a signature nobody checked.
   */
  readonly sendDirect: (
    to: string,
    body: string,
  ) => Effect.Effect<{ readonly sent: boolean; readonly reason?: string }>
  /**
   * 🔴 Ask ONE peer a question, and bring back what they said — the vision's own scenario: *"One
   * Nova asks another 'what happened in the world today?' instead of reaching for web search."*
   *
   * ⚠️ The answer is a stranger's words and arrives UNVERIFIED until checked here: the reply is
   * refused unless its signature covers the author, the asker, the question and the answer, so a
   * reply cannot be replayed from another exchange or edited on the way.
   */
  readonly askPeer: (
    to: string,
    question: string,
  ) => Effect.Effect<{
    readonly answer?: string
    readonly author?: string
    /**
     * 🔴 A TOKEN, never the peer's bytes (review 1.6). Their free text was interpolated into the
     * model's sentence unframed and unverified; `"unrecognised"` is what an unknown reason becomes.
     */
    readonly refused?: CommunityAnswer.WireRefusal | "unrecognised"
    readonly reason?: string
  }>
  readonly successions: (
    announce?: CommunitySuccession.Statement,
  ) => Effect.Effect<{ readonly told: number; readonly learned: number }>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunitySync") {}

/** What a peer sends back. Parsed rather than trusted: a peer is an untrusted source of bytes. */
const AnswerReply = Schema.Struct({
  answer: Schema.optional(Schema.String),
  refused: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number),
  signature: Schema.optional(Schema.String),
  /** The refusal's own proof — see the dealing below for why a refusal needs one. */
  refusalAt: Schema.optional(Schema.Number),
  refusalSignature: Schema.optional(Schema.String),
})

const Summary = Schema.Struct({ buckets: Schema.Array(Schema.String) })
const Ids = Schema.Struct({ ids: Schema.Array(Schema.String) })
const Listed = Schema.Struct({ channels: Schema.Array(Schema.String) })
const OfferAnswer = Schema.Struct({
  offer: Schema.optional(
    Schema.Struct({
      kind: Schema.String,
      endpoint: Schema.String,
      models: Schema.Array(Schema.String),
      price: Schema.String,
      /**
       * 🔴 DECLARED, or the decode silently DROPS it and every collected offer stops verifying.
       *
       * Caught live: a peer published an offer carrying a payment address, served it correctly, and
       * this instance collected NOTHING — because the field was stripped here before `verify` saw it,
       * so a perfectly good signature failed over bytes that had been removed on the way in. It looks
       * exactly like a peer signing badly, which is the wrong thing to go and investigate.
       *
       * ⚠️ The same trap as an undeclared field on a RESPONSE schema, and this program has now been
       * bitten by both directions of it. Any field added to the offer envelope must be added here too.
       */
      payTo: Schema.String,
      from: Schema.String,
      at: Schema.Number,
      signature: Schema.String,
    }),
  ),
})
/**
 * 🔴 The peer identity probe, and it is NOT `/global/health`.
 *
 * It was, and that path is authenticated: on an instance with a password it answers 401, so
 * bootstrap by address failed entirely between two secured instances — `{"learned":0,"asked":0}`,
 * an empty peer table, `no-peers` — while every other peer path answered normally. The vision's
 * "one living node is a complete entry point" did not hold for anyone who set a password, which is
 * the recommended configuration for an instance reachable from outside.
 */
export const IDENTITY_PATH = "/api/community/identity"

const Health = Schema.Struct({
  networkID: Schema.String,
  sealingKey: Schema.optional(Schema.String),
  sealingSignature: Schema.optional(Schema.String),
  /**
   * ⚠️ Declared, or the decode DROPS it and every probe fails to prove — the trap this file records
   * twice already (the offer envelope, the succession statement).
   */
  proof: Schema.optional(Schema.String),
})
const Successions = Schema.Struct({
  statements: Schema.Array(
    Schema.Struct({
      predecessor: Schema.String,
      successor: Schema.String,
      at: Schema.Number,
      signature: Schema.String,
      /**
       * ⚠️ Declared or the decode DROPS it, and the whole statement then fails to verify — the same
       * trap the offer envelope above records, which this repo has now been bitten by in both
       * directions. Any field added to a signed envelope must be added here too.
       */
      successorSignature: Schema.String,
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

const Ack = Schema.Struct({
  received: Schema.Boolean,
  /** The recipient's proof that they received THIS message — see `sendDirect`. */
  by: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number),
  signature: Schema.optional(Schema.String),
})

const PER_REQUEST_TIMEOUT_MS = 10_000

/**
 * How long to wait for an ANSWER, which is the one request that costs the other side a model turn.
 *
 * 🔴 Ten seconds is right for the rest of this file — a summary, a page of ids, a DM ack are all
 * database reads. It is too short for a model turn, so `askPeer` gave up before an honest instance
 * could reply.
 *
 * ⚠️ **This is a BACKSTOP, not the mechanism.** The answering turn is already bounded where it
 * should be: `ReasoningBudget` counts reasoning tokens live, nudges the model as they run down, and
 * has a MECHANICAL hard stop that forces an answer when they are gone — the same machinery the title
 * pass uses to generate with almost no reasoning at all. A token budget bounds the MODEL; it cannot
 * bound a provider that stalls mid-stream or a socket that never closes, and that is the only thing
 * this number is for.
 *
 * ⚠️ Deliberately LONGER than the answering side's own wall-clock bound, so the peer stops working
 * before we stop waiting. The other way round wastes their tokens on an answer nobody will read.
 */
export const ANSWER_TIMEOUT_MS = 60_000

/**
 * The most time ONE `askPeer` may take in total, across every address it tries.
 *
 * 🔴 A per-request budget inside a loop is not a budget. A peer may hold up to
 * `MAX_CONTACT_ROUTES` (6) addresses, so raising the per-answer wait to 60 s took the worst case
 * from 120 s to **420 s** — seven minutes of an agent, and of the person waiting on it, for one
 * question. That regression arrived with the fix on the line above, which is exactly how a bound
 * granted in one place becomes a hang in another.
 *
 * ⚠️ Sized for ONE honest attempt — a probe plus a full answer — and a little slack. Further
 * addresses are tried only with what is left, so a peer with six stale routes costs the same as a
 * peer with one.
 */
export const ASK_TOTAL_MS = 75_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service
    const identity = yield* InstanceIdentityStore.Service
    const ledger = yield* CommunityObservation.Service
    // 🔴 `speaks()` rather than the airgap alone: an instance that has not JOINED must not reach out
    // either. Gating only the inbound door was the first attempt and it left the bigger half open —
    // outbound connections are precisely what reveal the user's IP to a stranger, which is the thing
    // the warning they accepted is about. `participates` covers BOTH conditions, and reads each live.
    const speaks = () => CommunityConsent.participates(CommunityConsent.currentGate())
    /**
     * When each channel was last caught up on. Held in memory on purpose: a restart is exactly when
     * catching up matters most, so it should never be the thing a stale stamp suppresses.
     */
    const lastSynced = new Map<string, number>()
    /** When each (peer, question) pair was last asked — in memory, like the catch-up stamps above. */
    const lastAsked = new Map<string, number>()
    const contacts = yield* CommunityContacts.Service
    const channels = yield* CommunityChannels.Service
    const peers = yield* CommunityPeers.Service
    const successions = yield* CommunitySuccession.Store
    // ⚠️ Acquired when the layer is BUILT, not inside the call — a `yield*` in the method body makes
    // the service a requirement of every caller instead of a dependency of this one.
    const direct = yield* CommunityDirect.Service
    const offers = yield* CommunityOffer.Service
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
      /** ⚠️ Per call, because one of these routes costs the peer a model turn and the rest are reads. */
      budgetMs: number | undefined = PER_REQUEST_TIMEOUT_MS,
      /** ⚠️ Per call for the same reason: 4 MB is derived from a page of messages, not from a sentence. */
      ceilingBytes: number = MAX_PEER_RESPONSE_BYTES,
    ) =>
      // The dial itself lives in `transport.ts` — see `askPeerJson` for why the ceiling check and the
      // call had to move together (). What stays here is this route family's DEFAULTS.
      askPeerJson({
        http,
        route,
        path,
        body,
        schema,
        method,
        timeoutMs: budgetMs ?? PER_REQUEST_TIMEOUT_MS,
        ceilingBytes,
      })

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
      /**
       * 🔴 BREADTH CAP, and its absence was the seventh finding surviving in the paths that fix
       * never reached. `transport.publish` and `search.broadcast` both cap fan-out at 8; every loop
       * in this file walked the WHOLE table.
       *
       * ⚠️ Worse here than a socket storm, because these loops are SEQUENTIAL with an 8 s per-peer
       * timeout: a peer table filled to its allowed 500 turns one press of "look for instances" into
       * up to 66 minutes of waiting. A user action that never returns is indistinguishable from a
       * frozen app, and nothing a stranger sent was even wrong — they only had to be reachable.
       *
       * ⚠️ Sliced AFTER de-duplication by route, so the cap counts distinct boxes rather than
       * spellings of the same one. Contacts come first in the list this is built from, so the
       * people the user actually added are the ones that survive the cut.
       */
      return yield* CommunityReach.reachable({ contacts, peers, limit: MAX_PEERS_ASKED })
    })

    /**
     * 🔴 **WHO answers at this address — proven, not claimed** (Codex review P1, 2026-08-17).
     *
     * Every caller here used to take `networkID` off a plain `GET` and believe it. Nothing in that
     * response was bound to the request, so a hostile endpoint that replayed a victim's published
     * tuple became that victim as far as this instance was concerned: it could be prepended to the
     * user's contact routes by `reached`, accept a DM it cannot open and return the uniform ack so
     * `sendDirect` reported success, and have its unsigned refusal recorded as a first-hand dealing
     * about somebody else.
     *
     * So the caller mints 32 random bytes and demands a signature over them. A peer that does not
     * answer the challenge is not refused as hostile — it is simply not PROVEN, and every use here
     * needs proof.
     *
     * ⚠️ The nonce is per PROBE, never cached. A reused challenge is a static claim again, one round
     * later.
     */
    const probeIdentity = Effect.fn("CommunitySync.probeIdentity")(function* (route: string, budgetMs?: number) {
      const challenge = randomBytes(InstanceIdentityStore.CHALLENGE_BYTES).toString("base64url")
      const health = yield* ask(
        route,
        `${IDENTITY_PATH}?challenge=${challenge}`,
        undefined,
        Health,
        "GET",
        budgetMs,
        MAX_SMALL_RESPONSE_BYTES,
      )
      if (health === undefined) return undefined
      if (!InstanceIdentityStore.verifyIdentityProof(health.networkID, challenge, health.proof)) return undefined
      return health
    })

    /**
     * 🔴 A peer ANSWERED us at this address — the one place that fact gets recorded.
     *
     * `contacts.observe` is documented as "repair… the self-healing story, safe for an agent or the
     * transport to do automatically" and had no caller at all, so a contact whose address changed
     * was never repaired: the user's own address book kept pointing at somewhere dead while the peer
     * table quietly knew better.
     *
     * ⚠️ ONE helper rather than the call written out at each of the five sites that already mark
     * `peers.seen`. This subsystem's recurring failure is a cross-cutting rule applied where someone
     * REMEMBERED — blocking missing from two doors, the airgap missing from ten — and a sixth site
     * added later inherits this instead of having to recall it.
     *
     * ⚠️ ADDITIVE, never replacing, which `peers.learn` states the reason for one file over: "a LAN
     * address and a public address are both true at once, and replacing would make the last source
     * to speak the only one that counts". Writing just the answering route would delete a contact's
     * other addresses — repair that costs reachability is not repair. The live one goes FIRST, so
     * the address we just proved is the one tried first next time.
     */
    /**
     * 🔴 Routes that just failed, so the NEXT catch-up starts where the last one stopped.
     *
     * ⚠️ Bounded like every other in-memory map here: the keys are routes, and routes come from
     * peers. Insertion order is eviction order, which for a rolling window is oldest-first.
     */
    const failedAt = new Map<string, number>()
    const noteFailure = (route: string) => {
      failedAt.set(route, Date.now())
      if (failedAt.size > MAX_SYNC_STAMPS) {
        const oldest = failedAt.keys().next()
        if (!oldest.done) failedAt.delete(oldest.value)
      }
    }
    const failedRecently = (route: string) => {
      const at = failedAt.get(route)
      return at !== undefined && Date.now() - at < ROUTE_COOLDOWN_MS
    }

    /** Remember that this room was just caught up, bounded like every other stamp map here. */
    const stampCooldown = (wanted: string) => {
      lastSynced.set(wanted, Date.now())
      // Insertion order is eviction order, which for a rolling window is oldest-first.
      if (lastSynced.size > MAX_SYNC_STAMPS) {
        const oldest = lastSynced.keys().next()
        if (!oldest.done) lastSynced.delete(oldest.value)
      }
    }

    const reached = Effect.fn("CommunitySync.reached")(function* (networkID: string, route: string) {
      failedAt.delete(route)
      yield* peers.seen(networkID)
      // Not a contact: the peer table already holds it, and `observe` deliberately cannot create one.
      const known = yield* contacts.get(networkID)
      if (known === undefined) return
      const merged = [route, ...known.routes.filter((entry) => entry !== route)].slice(0, MAX_CONTACT_ROUTES)
      yield* contacts.observe(networkID, merged)
    })

    /**
     * 🔴 Every address we may dial for ONE peer, with the user's BLOCK honoured — §5(i) of
     * `notes/spec/honesty-ledger.md`: *the user outranks the ledger*, and `AGENTS.md` keeps who you
     * block out of the agent's reach entirely.
     *
     * ⚠️ Blocking is stored on the CONTACT row and `bootstrap()` honours it, but a peer met on the
     * LAN, through peer exchange or through the DHT lives in the PEERS table — which both dialling
     * paths also read. Measured 2026-08-17: a blocked peer still contributed a route from there, so
     * an agent could put a question to somebody its user had blocked, or send them a message. The
     * block reached the half it was written on and no further.
     */
    const dialableRoutes = Effect.fn("CommunitySync.dialableRoutes")(function* (to: string) {
      return yield* CommunityReach.routesFor({ contacts, peers, to })
    })
    return Service.of({
      sendDirect: Effect.fn("CommunitySync.sendDirect")(function* (to: string, body: string) {
        if (!speaks()) return { sent: false, reason: "offline" }

        /**
         * ⚠️ Only routes belonging to THIS recipient, and their key is read from the instance that
         * answers there. A peer describing another peer's sealing key would be exactly the
         * substitution `compose` refuses — so it is never asked.
         */
        const addresses = yield* dialableRoutes(to)
        if (addresses.length === 0) return { sent: false, reason: "no-route" }

        /**
         * ⚠️ Bound to a NAME, because `self` in this scope is the global `Window` — the typecheck
         * caught it reading `self.networkID` off the DOM, which would have compiled to `undefined`
         * on a runtime that has one and made every delivery proof fail open.
         */
        const me = (yield* identity.identity()).networkID
        let lastRejection: string | undefined
        for (const address of addresses) {
          const health = yield* probeIdentity(address)
          // A different identity at that address means the route is stale or someone else is there.
          // Either way it is not the person we are writing to.
          if (health === undefined || health.networkID !== to) continue
          if (health.sealingKey === undefined || health.sealingSignature === undefined) continue

          const composed = yield* direct.compose({
            to,
            sealingKey: health.sealingKey,
            sealingSignature: health.sealingSignature,
            body,
          })
          /**
           * ⚠️ CONTINUE, not return (Codex review P1). A rejection here means the key this address
           * offered was unusable — which is exactly what a hostile endpoint supplies — and the next
           * address may be the genuine instance. Ending the send on the first bad tuple let one
           * impostor route black-hole a message that had a working route behind it.
           */
          if ("rejected" in composed) {
            lastRejection = composed.rejected
            continue
          }

          const ack = yield* ask(address, DM_PATH, composed.message, Ack, "POST", undefined, MAX_SMALL_RESPONSE_BYTES)
          /**
           * 🔴 **`sent` means the RECIPIENT proved they got it** (Codex review P1).
           *
           * A hostile endpoint claiming this peer's key accepted the ciphertext it could not open,
           * answered the uniform `{received:true}`, and the user was told their message was sent —
           * a black hole that reports success. The ack is now bound to the recipient, to us, and to
           * this message's id, so only the real holder of the key can produce one.
           *
           * ⚠️ An unproven ack does NOT end the loop: the next route may be the genuine instance.
           * Treating it as delivery was the bug; treating it as fatal would be a second one.
           */
          const delivered =
            ack !== undefined &&
            ack.signature !== undefined &&
            CommunityDirect.verifyDelivery(
              {
                recipient: ack.by ?? "",
                sender: me,
                message: CommunityDirect.messageID(composed.message),
                at: ack.at ?? 0,
                signature: ack.signature,
              },
              { recipient: to, sender: me, message: CommunityDirect.messageID(composed.message) },
            )
          // ⚠️ Stored either way — `compose` already kept our copy. A send that failed to reach them
          // must not also lose what the user wrote.
          if (delivered) {
            yield* reached(to, address)
            return { sent: true }
          }
        }
        return { sent: false, reason: lastRejection ?? "unreachable" }
      }),

      askPeer: Effect.fn("CommunitySync.askPeer")(function* (to: string, question: string) {
        if (!speaks()) return { reason: "offline" }

        /**
         * ⚠️ Only routes belonging to THIS peer, blocked peers excluded, and their identity is read
         * from the instance that answers there — an address is hearsay, and the only thing that
         * settles who is behind it is asking.
         */
        const addresses = yield* dialableRoutes(to)
        if (addresses.length === 0) return { reason: "no-route" }

        /**
         * ⚠️ Checked AFTER the routes, so a peer we cannot reach is told the truth about why, and
         * BEFORE the dial, which is the only place a cooldown saves anybody anything.
         */
        const repeat = `${to}::${question.trim()}`
        const now = Date.now()
        const asked = lastAsked.get(repeat)
        if (asked !== undefined && now - asked < ASK_COOLDOWN_MS) return { reason: "too-soon" }

        const self = yield* identity.identity()
        const at = Date.now()
        /**
         * 🔴 SIGNED, because the answering side bounds its budget PER ASKER. An unsigned `asker`
         * is a name anybody can write, so the share we consume would be charged to whoever we
         * claimed to be — and the dealing they record on answering would name them, not us.
         */
        /**
         * ⚠️ `to` is inside the signature, so this ask is worthless to anyone who captures it: it
         * verifies at THIS peer and nowhere else. Before that, one captured question could be
         * replayed across the network to burn our share — and now our standing — at every instance.
         */
        const signature = yield* identity.sign(
          CommunityAnswer.askBytes({ to, asker: self.networkID, question, at }),
        )
        const payload = { to, asker: self.networkID, question, at, signature: signature.toString("base64url") }

        /**
         * ⚠️ ONE deadline for the whole call, not one per address. Each attempt gets whatever is
         * left, so trying six routes costs what trying one costs.
         */
        const deadline = Date.now() + ASK_TOTAL_MS
        for (const address of addresses) {
          const remaining = deadline - Date.now()
          // Not enough left to probe AND answer: stopping is more honest than starting something we
          // will abandon, and the caller is told `unreachable` rather than waiting for it.
          if (remaining <= 0) break

          const health = yield* probeIdentity(address, Math.min(remaining, PER_REQUEST_TIMEOUT_MS))
          // A different identity at that address means the route is stale or someone else is there.
          if (health === undefined || health.networkID !== to) continue

          /**
           * ⚠️ Stamped once there is genuinely somebody to ask, for the reason the catch-up
           * cooldown records: recording the ATTEMPT would let an instance that reached nobody refuse
           * to try again for a minute, and a fresh install does exactly that.
           */
          lastAsked.set(repeat, now)
          if (lastAsked.size > MAX_SYNC_STAMPS) {
            // Insertion order is eviction order, which for a rolling window is oldest-first.
            const oldest = lastAsked.keys().next()
            if (!oldest.done) lastAsked.delete(oldest.value)
          }

          const reply = yield* ask(
            address,
            ASK_PATH,
            payload,
            AnswerReply,
            "POST",
            Math.max(1, Math.min(deadline - Date.now(), ANSWER_TIMEOUT_MS)),
            MAX_ANSWER_BYTES,
          )
          if (reply === undefined) continue
          yield* reached(to, address)

          /**
           * 🔴 THE DEALING, recorded here — the half of *"answering is a dealing recorded on both
           * sides"* that had nowhere to happen. The answering instance already records that it
           * answered; without this the ledger only ever hears from the party being judged.
           *
           * ⚠️ Recorded ONLY once they actually replied, and that bound is the whole reason this
           * lives in `sync` rather than in the tool. `recordFirstHand` skips the engagement check
           * because its callers just performed the dealing; a version that recorded before a reply
           * would let an agent mint first-hand observations about any stranger it could NAME, which
           * is precisely the attack the engagement bound exists to stop. A refusal and a malformed
           * answer are both real dealings and both count — *"they would not answer"* is exactly
           * what standing is made of, and keeping only the flattering half would be a lie of
           * omission.
           */
          const dealing = (outcome: string) =>
            ledger.recordFirstHand({ subject: to, at: Date.now(), context: "asked", outcome })

          if (reply.refused !== undefined) {
            /**
             * 🔴 **A DEALING is recorded only against a refusal this peer PROVED** (Codex review P1).
             *
             * *"They would not answer"* is exactly what standing is made of, so this writes a
             * first-hand observation about `to` — and while a refusal carried no signature, anything
             * answering at that address could make us write one in a victim's name. The identity
             * challenge settles who is at the address; this settles what they said once there.
             *
             * ⚠️ An unproven refusal is still REPORTED to the user — it is what the far end said, and
             * hiding it would leave a silent failure — it simply earns nobody a dealing. Reporting
             * and recording are different acts, and only one of them is a claim about a person.
             */
            const proven =
              reply.refusalSignature !== undefined &&
              CommunityAnswer.verifyRefusal(
                {
                  author: to,
                  asker: self.networkID,
                  request: payload.signature,
                  reason: reply.refused,
                  at: reply.refusalAt ?? 0,
                  signature: reply.refusalSignature,
                },
                { author: to, asker: self.networkID, request: payload.signature },
              )
            if (proven) yield* dealing(CommunityObservation.Outcome.REFUSED)
            /**
             * 🔴 Mapped to our own vocabulary HERE, at the seam the bytes arrive at, rather than
             * anywhere they are rendered. A stranger's free text with our sentence wrapped around it
             * is how it reached the model unframed.
             */
            return { refused: CommunityAnswer.asWireRefusal(reply.refused) ?? "unrecognised" }
          }
          if (reply.answer === undefined) {
            yield* dealing(CommunityObservation.Outcome.NO_ANSWER)
            return { reason: "no-answer" }
          }

          /**
           * 🔴 VERIFIED, or thrown away. The whole value of an answer is that its author staked
           * their standing on it — which is worth exactly nothing if we accept a reply we cannot
           * attribute. The signature covers the author, US, the question and the answer, so a reply
           * to somebody else's question cannot be replayed at us and the text cannot be edited in
           * flight by whatever carried it.
           */
          const signed = {
            author: reply.author ?? "",
            asker: self.networkID,
            question,
            answer: reply.answer,
            at: reply.at ?? 0,
            signature: reply.signature ?? "",
          }
          if (!CommunityAnswer.verify(signed)) {
            yield* dealing(CommunityObservation.Outcome.UNSIGNED)
            return { reason: "bad-signature" }
          }
          /**
           * ⚠️ And the author must be the peer we ASKED. A valid signature by somebody else is a
           * perfectly good answer to a question we did not put to them.
           */
          if (signed.author !== to) {
            yield* dealing(CommunityObservation.Outcome.MISATTRIBUTED)
            return { reason: "wrong-author" }
          }

          yield* dealing(CommunityObservation.Outcome.ANSWERED)
          return { answer: reply.answer, author: signed.author }
        }
        return { reason: "unreachable" }
      }),

      successions: Effect.fn("CommunitySync.successions")(function* (announce) {
        if (!speaks()) return { told: 0, learned: 0 }
        let told = 0
        let learned = 0
        for (const peer of yield* reachable) {
          if (announce !== undefined) {
            const ack = yield* ask(peer.route, SUCCESSION_PATH, announce, Ack, "POST", undefined, MAX_SMALL_RESPONSE_BYTES)
            if (ack !== undefined) told++
          }
          const theirs = yield* ask(peer.route, SUCCESSION_PATH, undefined, Successions, "GET", undefined, MAX_SMALL_RESPONSE_BYTES)
          if (theirs === undefined) continue
          yield* reached(peer.networkID, peer.route)
          // ⚠️ Sliced: each statement costs a signature verification, and the count is theirs.
          const claimed = [...theirs.statements].slice(0, MAX_SUCCESSIONS_PER_ANSWER)
          for (const statement of claimed) if (yield* successions.remember(statement)) learned++
          // ⚠️ `followAll` and not a loop of `follow`: statements arrive from a mesh in no order, and
          // single-stepping drops a link whose predecessor has not been seen yet and never retries.
          yield* contacts.followAll(claimed)
        }
        return { told, learned }
      }),

      channelsNearby: Effect.fn("CommunitySync.channelsNearby")(function* () {
        if (!speaks()) return []
        const joined = (yield* channels.channels()).map((entry) => CommunityTopic.canonical(entry.name))
        const seen = new Map<string, string>()
        for (const peer of yield* reachable) {
          const answer = yield* ask(peer.route, LISTED_PATH, undefined, Listed, "GET", undefined, MAX_SMALL_RESPONSE_BYTES)
          if (answer === undefined) continue
          yield* reached(peer.networkID, peer.route)
          // ⚠️ Sliced: every name becomes a row in a Map this returns to the app.
          for (const name of [...answer.channels].slice(0, MAX_LISTED_PER_ANSWER)) {
            // ⚠️ Keyed CANONICALLY, so two peers spelling one room differently offer it once — the
            // same rule that stops a second spelling becoming a second room locally.
            const key = CommunityTopic.canonical(name)
            if (joined.includes(key) || seen.has(key)) continue
            seen.set(key, name)
          }
        }
        return [...seen.values()]
      }),

      identify: Effect.fn("CommunitySync.identify")(function* (address: string) {
        /**
         * 🔴 WHO lives at an address — the first half of adding a doorman by hand.
         *
         * `learnFrom` already asks this and then throws the answer away, keeping only a count. The
         * doorman flow needs the identity itself, because the user is making a statement ABOUT A
         * PERSON ("I trust them this far") and a trust rating attached to an address would survive
         * that address being reassigned to somebody else.
         *
         * ⚠️ The reply is a claim like any other. What it buys is that the route is real and
         * reaches something speaking this protocol; every message from that key is verified against
         * it afterwards regardless.
         */
        if (!speaks()) return undefined
        /**
         * ⚠️ A TYPED address, so it may have no scheme — and `httpRoutes` drops those, which is
         * how this answered "nobody lives there" about a host that was answering. Each candidate is
         * tried in turn, secure first.
         */
        for (const route of typedRoutes(address)) {
          const health = yield* probeIdentity(route)
          if (health !== undefined) return { networkID: health.networkID, route }
        }
        return undefined
      }),

      learnFrom: Effect.fn("CommunitySync.learnFrom")(function* (addresses, source = "lan") {
        if (!speaks()) return 0
        let learned = 0
        for (const address of addresses) {
          /**
           * 🔴 `typedRoutes`, not `httpRoutes` — because not every source carries a scheme.
           *
           * `httpRoutes` drops anything `new URL()` cannot parse, which is right for mDNS and peer
           * exchange, where a scheme always rides along. **The DHT hands back bare `host:port`**, so
           * every address the public directory found was filtered out HERE, before a single dial —
           * `dht.ts` said its result was "exactly what `learnFrom` already consumes" and it was not.
           * The sidecar could work perfectly and no peer would ever be added. Found by having one
           * instance ask another and watching `no-route` come back for an address just learned.
           *
           * ⚠️ Costs at most one extra dial, and only for scheme-less entries: `typedRoutes` returns
           * a well-formed URL unchanged, and otherwise tries HTTPS before plaintext so a pasted
           * public host is never silently downgraded.
           */
          /**
           * 🔴 The address-class rule applies to the PROBE, not only to the store (review 1.3).
           *
           * `learnFrom` dials each candidate before it stores anything, so validating only inside
           * `peers.learn` would leave the dial itself — a `GET` to whatever a public DHT entry or a
           * DNS seed named, from inside the user's network — as the SSRF primitive, with the
           * refusal arriving one step too late to matter.
           */
          for (const route of typedRoutes(address).filter(
            (candidate) => CommunityRoute.dialable(candidate, { hearsay: CommunityRoute.isHearsay(source) }) !== undefined,
          )) {
            // ⚠️ ASK who they are rather than trusting a claim attached to the address. The reply
            // is only a claim too — anyone can serve a health endpoint — but a peer's key is not a
            // secret and every message it sends is verified against it anyway. What this buys is
            // that the route is real and reaches something that speaks our protocol.
            const health = yield* probeIdentity(route)
            if (health === undefined) continue
            /**
             * ⚠️ The route STORED is the one that answered, scheme and all — so everything
             * downstream that filters with `httpRoutes` keeps working on it. Storing the bare form
             * would move this same defect one step later, into `sendDirect` and `askPeer`.
             */
            if (yield* peers.learn(health.networkID, [route], source)) learned++
            break
          }
        }
        return learned
      }),

      discover: Effect.fn("CommunitySync.discover")(function* () {
        if (!speaks()) return { asked: 0, learned: 0 }
        let asked = 0
        let learned = 0
        for (const peer of yield* reachable) {
          const answer = yield* ask(peer.route, PEERS_PATH, undefined, PeerList, "GET", undefined, MAX_SMALL_RESPONSE_BYTES)
          if (answer === undefined) continue
          asked++
          // It answered, so it is alive: this is what keeps a working peer ahead of invented ones
          // when the table is evicted.
          yield* reached(peer.networkID, peer.route)
          /**
           * ⚠️ Collected in the SAME round as peer exchange rather than in a pass of its own: we are
           * already talking to this instance, and a second sweep would double the traffic for a
           * question it could have answered the first time.
           */
          const advertised = yield* ask(peer.route, OFFER_PATH, undefined, OfferAnswer, "GET", undefined, MAX_SMALL_RESPONSE_BYTES)
          if (advertised?.offer !== undefined) {
            // `learn` verifies and refuses anything claiming to be ours — a peer describing a THIRD
            // party's endpoint is exactly what a signature is here to make harmless.
            yield* offers.learn(advertised.offer as CommunityOffer.Signed)
          }

          // ⚠️ Sliced: every entry is a database write, and eviction work behind it.
          for (const named of [...answer.peers].slice(0, MAX_PEERS_PER_ANSWER)) {
            // ⚠️ `learn` does the refusing — our own key, and anything that is not a public key. A
            // peer describing peers is hearsay, so every claim is filtered by the store rather than
            // trusted because it arrived over a connection that worked.
            /**
             * 🔴 The INTRODUCER is recorded, not just the fact of hearsay — (dd).
             *
             * The loop variable is `named` rather than `peer` because the peer we are ASKING is what
             * the edge is about, and the inner name used to shadow it. The introducer was in scope
             * the whole time and thrown away, which is exactly how a cluster and a consensus come to
             * look like the same shape.
             */
            if (yield* peers.learn(named.networkID, [...named.routes], "px", peer.networkID)) learned++
          }
        }
        return { asked, learned }
      }),

      sync: Effect.fn("CommunitySync.sync")(function* (channel: string) {
        // The airgap gate, first and by the same argument as the transport's: a community is egress
        // the user chose, and airgap has to be able to withdraw that choice.
        if (!speaks()) return { peers: 0, fetched: 0 }

        /**
         * 🔴 A cooldown, because both callers can repeat far faster than the network changes.
         *
         * Catch-up costs a round trip PER PEER, and the two things that trigger it are a user
         * switching channels and a model calling `history` — a model in a loop can ask twenty times
         * in the seconds a person takes to ask once. Every one of those asks is a cost we impose on
         * OTHER people's instances, which is the side of the ledger this subsystem usually looks at
         * from the receiving end: the same reasoning that bounds what a peer can make us assemble
         * applies to what we can make a peer assemble.
         *
         * ⚠️ Per channel, not global — catching up on one room must not silence a first-ever sync of
         * another.
         */
        /**
         * 🔴 A room this instance is NOT IN costs the peer a full exchange and yields nothing.
         *
         * `deliver` rejects an unsubscribed message, so every byte fetched for such a room is
         * downloaded and dropped — and the cost lands on somebody else's machine. Measured before
         * this guard: an instance that had LEFT a room still dialled, found the summaries differing,
         * asked for the ids, asked for the messages, and stored none of them.
         *
         * ⚠️ Not a theoretical door. The agent tool's `history` op catches up on whatever channel
         * name a model writes, and the route takes one too; only the panel is limited to rooms the
         * user actually joined. Checked HERE rather than at each caller for the reason this file
         * already has one `reached` helper: a rule applied per caller is a rule somebody forgets.
         *
         * ⚠️ Compared canonically, because `#NovaClaw` and `#novaclaw` are ONE room — the same
         * normalisation `channelsNearby` uses, and the mistake `setMuted` made by comparing
         * literally.
         */
        const wanted = CommunityTopic.canonical(channel)

        /**
         * 🔴 Keyed CANONICALLY, and checked BEFORE the database.
         *
         * Both halves were wrong when this cooldown was written. The key was the raw name while
         * everything else in this subsystem canonicalises, so `#NovaClaw` and `#novaclaw` held
         * SEPARATE stamps — measured: three spellings, three fresh dials, a bound defeated by one
         * character. That is precisely the mistake `setMuted` made and this codebase documents:
         * leaving `#Recipes` while joined as `#recipes` matched no row.
         *
         * ⚠️ And it sat AFTER the subscription check, which reads the database. A suppressed repeat
         * is supposed to be the cheap path — it cannot be, behind a query. Cheap, in-memory,
         * decisive checks first; the ones that touch storage after.
         */
        const now = Date.now()
        const last = lastSynced.get(wanted)
        if (last !== undefined && now - last < SYNC_COOLDOWN_MS) return { peers: 0, fetched: 0 }

        /**
         * 🔴 A room this instance is NOT IN costs the peer a full exchange and yields nothing.
         *
         * `deliver` rejects an unsubscribed message, so every byte fetched for such a room is
         * downloaded and dropped — and the cost lands on somebody else's machine. Measured before
         * this guard: an instance that had LEFT a room still dialled, found the summaries differing,
         * asked for the ids, asked for the messages, and stored none of them.
         *
         * ⚠️ Not a theoretical door. The agent tool's `history` op catches up on whatever channel
         * name a model writes, and the route takes one too; only the panel is limited to rooms the
         * user actually joined.
         */
        const joined = yield* channels.channels()
        if (!joined.some((entry) => CommunityTopic.canonical(entry.name) === wanted))
          return { peers: 0, fetched: 0 }

        const dialable = yield* reachable
        if (dialable.length === 0) return { peers: 0, fetched: 0 }

        /**
         * 🔴 The cooldown is stamped when somebody ANSWERS, not when we decide to try — review §2.
         *
         * "Somebody to ask" is not "somebody who answered", and the difference is a permanent
         * outage rather than a slow one: a dead first contact burned the window, the caller's own
         * 5 s timeout cut the attempt before the second peer, and the next thirty seconds refused to
         * try at all. The same peer, the same failure, forever. See `stampCooldown` below.
         */
        const topic = CommunityTopic.topicOf(channel)
        let answered = 0
        let fetched = 0
        /**
         * 🔴 The whole call's budget. Checked before each peer, so a slow one costs its own timeout
         * and never the next peer's turn — and `sync` returns in a time a user can feel rather than
         * in however long the peer table happens to take.
         */
        const deadline = now + SYNC_TOTAL_MS

        for (const { networkID, route } of dialable) {
          if (Date.now() >= deadline) break
          /**
           * ⚠️ A route that failed a moment ago is SKIPPED, not retried first. `reachable` is stably
           * ordered, so without this the same dead contact was dialled first every time and catch-up
           * never reached anybody behind it.
           */
          if (failedRecently(route)) continue
          const mine = yield* channels.ids(channel)
          const theirs = yield* ask(route, SYNC_SUMMARY_PATH, { topic }, Summary, "POST", undefined, MAX_SMALL_RESPONSE_BYTES)
          if (theirs === undefined) {
            noteFailure(route)
            continue
          }
          answered++
          yield* reached(networkID, route)

          const disagree = CommunityReconcile.differing(
            CommunityReconcile.summarize(mine),
            [...theirs.buckets],
          )
          if (disagree.length === 0) continue

          /**
           * 🔴 Asked in CHUNKS, and this is what makes the answerer's cap safe (Codex P1).
           *
           * The door bounds one answer at `MAX_IDS_PER_ANSWER`, because it is anonymous and was
           * returning ~335 KB for a ~200-byte request. A truncated answer does NOT converge on its
           * own — measured while writing the test for it: asking for the same differing buckets
           * again returns the same first N ids, so the exchange stalls exactly at the cap. What
           * converges is asking for FEWER buckets, because then each answer is complete for the
           * buckets it covers.
           *
           * ⚠️ EIGHT, and the number was measured rather than guessed. A room at its 5,000-message
           * retention bound holds ~78 ids per bucket on average and more in its fullest, so sixteen
           * buckets asked at once would answer ~1,260 — past the 1,024 ceiling, and the livelock
           * returns through the back door. Eight keeps the worst realistic answer inside it with
           * room to spare, at the cost of a few more small requests per catch-up.
           */
          const offeredIds: string[] = []
          for (let index = 0; index < disagree.length; index += BUCKETS_PER_REQUEST) {
            const chunk = disagree.slice(index, index + BUCKETS_PER_REQUEST)
            const answered = yield* ask(route, SYNC_IDS_PATH, { topic, buckets: chunk }, Ids, "POST", undefined, MAX_SMALL_RESPONSE_BYTES)
            if (answered === undefined) break
            /**
             * 🔴 **Each answer is clamped, and the accumulation stops at our own retention.**
             *
             * `MAX_IDS_PER_ANSWER` is what WE serve; a hostile answerer is bound by nothing. Asking
             * in chunks handed such a peer several chances to feed us ids where it previously had
             * one — caught by the flood test, not by reading this. Both halves are bounded now: the
             * per-answer slice, and the total, which cannot exceed what a room could legitimately
             * hold anyway.
             */
            offeredIds.push(...answered.ids.slice(0, CommunityReconcile.MAX_IDS_PER_ANSWER))
            if (offeredIds.length >= CommunityChannels.RETAIN_PER_CHANNEL) break
          }
          if (offeredIds.length === 0) continue
          const offered = { ids: offeredIds }

          /**
           * What we do not hold. `missing` deliberately returns what to REQUEST, so nothing arrives
           * because a sender decided it should — the same rule the ingress door enforces.
           *
           * 🔴 BOUNDED, because the id list is written by the peer. A hostile answer of a million
           * invented ids costs them one response and costs US thousands of round trips plus the array
           * to hold them — the asker paying for the answerer's claim, which is the same asymmetry the
           * peer table and the message bound already close.
           *
           * ⚠️ The bound is not arbitrary: retention keeps at most `RETAIN_PER_CHANNEL` messages per
           * room, so a peer legitimately holding more than that in one channel does not exist. Anything
           * past it is invented, and a sync that stops early still made progress — the next round
           * fetches the rest.
           */
          const wanted = CommunityReconcile.missing([...offered.ids], mine).slice(
            0,
            CommunityChannels.RETAIN_PER_CHANNEL,
          )
          for (let index = 0; index < wanted.length; index += MAX_MESSAGES_PER_REQUEST) {
            const batch = wanted.slice(index, index + MAX_MESSAGES_PER_REQUEST)
            const carried = yield* ask(route, SYNC_MESSAGES_PATH, { topic, ids: batch }, Messages)
            if (carried === undefined) break
            /**
             * ⚠️ Sliced to what we ASKED for. The request carried at most
             * `MAX_MESSAGES_PER_REQUEST` ids, so a longer answer is invented by definition — and
             * every element costs a signature check, a work check and a write at the ingress door.
             */
            for (const message of [...carried.messages].slice(0, MAX_MESSAGES_PER_REQUEST)) {
              // 🔴 THE ingress door. A peer we asked gets no more trust than a stranger who pushed.
              const result = yield* channels.deliver(topic, message as CommunityMessage.Proven)
              if ("stored" in result) fetched++
            }
          }
        }

        /**
         * 🔴 Stamped HERE, and only if somebody answered — the other half of the starvation fix.
         *
         * ⚠️ A sync that reached nobody must leave the window open: the next attempt is the one that
         * finds the peer who just came online. A sync that DID reach somebody has spent their
         * bandwidth, and repeating it a second later spends it again for nothing.
         */
        if (answered > 0) stampCooldown(wanted)
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
    CommunityDirect.node,
    CommunityOffer.node,
    CommunityObservation.node,
    InstanceIdentityStore.node,
    httpClient,
  ],
})
