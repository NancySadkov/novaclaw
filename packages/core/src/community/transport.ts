export * as CommunityTransport from "./transport"

import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { CommunityChannels } from "./channels"
import { CommunityContacts } from "./contacts"
import { CommunityPeers } from "./peers"
import { CommunityTopic } from "./topic"
import { CommunityMessage } from "./message"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { CommunityConsent } from "./consent"
import { CommunityReach } from "./reach"
import { CommunityRoute } from "./route"
import { Offline } from "../offline"

/**
 * Community P2 — the seam a transport plugs into (`notes/spec/community-p2p.md`).
 *
 * 🔴 This exists so ONE unmeasurable number stops blocking six phases. Choosing between iroh and
 * libp2p rests on cross-NAT success, which cannot be measured from a single machine — but that
 * choice is an implementation detail BEHIND this interface, not a prerequisite for it. The instance
 * asks for "publish this signed message" and "tell me what you can reach"; whatever satisfies that,
 * as a sidecar process in the llama.cpp pattern, is swappable without touching anything above.
 *
 * ⚠️ Incoming messages MUST arrive through `CommunityChannels.record`, never straight into the
 * table. That function is the one ingress door where signature, channel, block and duplicate rules
 * live; a transport that wrote rows itself would be a second door with none of them.
 */

export type State =
  /**
   * Nothing can carry a message, and the REASON is the whole point of this being a union.
   *
   * `airgap` — the user switched the network off machine-wide. `not-joined` — they have not accepted
   * what joining costs, so this instance is not on the network at all. `no-peers` — they have joined
   * and the transport works; we simply know nobody with an address to dial.
   *
   * THREE different sentences to a person, and each sends them somewhere else: turn off offline
   * mode, open the Community app and read the warning, or go and find somebody. One "disconnected"
   * state would tell a user whose contact list is merely empty that the software is broken — and
   * collapsing any two of these would send them to fix a thing that is already correct.
   *
   * ⚠️ `not-joined` was added when participation became a decision, and this note enumerated two
   * reasons for a while after the type carried three. The list is the argument for the union
   * existing, so it going stale costs more than an out-of-date comment usually does.
   *
   * ⚠️ There was a third, `none` — "no transport installed" — and it is GONE rather than retained for
   * symmetry. A transport now always exists, so `none` became a state nothing could return, and a
   * state that cannot occur is a branch every reader has to reason about for nothing.
   */
  | { readonly kind: "off"; readonly reason: "airgap" | "no-peers" | "not-joined" }
  | { readonly kind: "connecting" }
  | { readonly kind: "online"; readonly peers: number }

export interface Interface {
  readonly state: () => Effect.Effect<State>
  /**
   * Send a PROVEN message to a channel's subscribers.
   *
   * ⚠️ `Proven`, not `Signed`: every receiver's ingress door refuses work it cannot verify, so
   * handing the transport a message without its nonce would publish something guaranteed to be
   * rejected by everyone — a failure visible only on the far side.
   *
   * Returns false when nothing could carry it. NOT an error: "there is no network yet" is the
   * ordinary state of a fresh install, and a failing effect would turn it into a red screen.
   */
  readonly publish: (message: CommunityMessage.Proven) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityTransport") {}

/**
 * The transport, and it speaks **plain HTTPS to instances that are reachable**.
 *
 * 🔴 Chosen by the owner (2026-08-15), and it is a decision about censorship rather than performance:
 * *"we can't expect end users having unblocked UDP"*, *"strange UDP traffic attracts attention. It is
 * also easy to censor UDP."* A meaningful share of real networks pass only TCP 80/443, where QUIC is
 * not slower but ABSENT; sustained UDP to residential peers on odd ports is legible to whoever
 * watches the link; and dropping UDP costs an operator nothing while dropping 443 breaks the web.
 *
 * ⚠️ **This does NOT traverse NAT and does not pretend to.** An unreachable peer dials OUT to a
 * reachable one; two peers with nobody reachable between them cannot meet this way. That is the
 * accepted cost — §6's *relays should be instances*, §2's Nostr shape, where "no servers at all"
 * weakens into "anyone can be the server" and health depends on a PLURALITY of reachable instances.
 * The overlay bake-off stays ⛔ and is now an optimisation for the direct/LAN case.
 *
 * 🔴 It also keeps the airgap rule that made this seam the right home for it: a community feature is
 * egress the user chose, so airgap must be able to withdraw that choice — checked explicitly here AND
 * again by the shared `httpClient` node, which is the OFF-A chokepoint.
 */
/** Where a peer accepts community traffic. Every instance already serves this shape. */
export const INBOUND_PATH = "/api/community/inbound"

/**
 * Is this route something we can POST to?
 *
 * ⚠️ Routes are deliberately free-form because a peer is reachable in more ways than one — the
 * overlay arms use multiaddrs (`/ip4/…/udp/…/quic-v1`), which this must ignore rather than choke on.
 * A contact can therefore carry both kinds at once and each transport takes the ones it understands.
 */
/**
 * 🔴 The most a PEER'S ANSWER may be, checked before it is read — ONE rule, for every module that
 * dials a peer.
 *
 * `peer-body-limit.ts` closed this inbound after a 52.9 MB anonymous POST returned 200 and cost
 * +450 MB of commit. The outbound half was closed later, in `sync.ts`'s `ask` — and ONLY there.
 * `search.ts` has its own `askPeer`, which kept reading `response.json` with no ceiling: the fix had
 * been applied per caller, which is the mistake this subsystem records over and over (blocking
 * missing from two doors, the airgap from ten, `MAX_PEERS_ASKED` never reaching `sendDirect`).
 *
 * ⚠️ Lives HERE because it is the one module both dialling files already import. A constant they
 * each declared would drift the moment one was tuned.
 *
 * ⚠️ Derived, not picked: the largest honest answer is a `sync/messages` reply of 256 messages at
 * 8 KB each — about 2 MB — so 4 MB refuses a different order of magnitude without touching real
 * traffic. An answer that declares no length is refused for the reason the inbound limiter gives:
 * every honest responder is an instance answering with a JSON string, which always sets it.
 */
export const MAX_PEER_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * The ceiling for one ANSWER, which is a different shape from a page of messages.
 *
 * 🔴 4 MB is derived from `sync/messages` — 256 messages at 8 KB — and reusing it here accepts
 * five hundred times what any honest answerer can produce. The answering side bounds itself by
 * `maxTokens` (2048 by default, call it 8 KB of text), so a reply in the megabytes is not a verbose
 * peer, it is a peer doing something else.
 *
 * ⚠️ The agent's context is already protected downstream — tool output is truncated centrally —
 * so what this bounds is what we TRANSFER, HOLD and VERIFY before that: a signature check runs over
 * whatever arrived. 64 KB is eight times the honest maximum, which leaves room for a long answer and
 * none for a payload.
 */
export const MAX_ANSWER_BYTES = 64 * 1024

/**
 * Whether a peer's answer is small enough to read. Pure, so both callers share the DECISION.
 *
 * @param ceiling - the limit for THIS route. Defaults to the sync-sized one; an answer passes its own,
 * because a rule derived for one shape is not a rule for another.
 */
export const answerTooLarge = (
  headers: Readonly<Record<string, string | undefined>>,
  ceiling: number = MAX_PEER_RESPONSE_BYTES,
): boolean => {
  const declared = Number(headers["content-length"])
  return !Number.isFinite(declared) || declared > ceiling
}

/**
 * Dial one peer, decode its answer, and answer `undefined` for every way that can fail. THE one
 * implementation — `sync.ts` and `search.ts` each had their own until 2026-09-01 ().
 *
 * 🔴 **The constant living here was not enough, and that is the lesson this module keeps recording.**
 * `MAX_PEER_RESPONSE_BYTES` above was moved here precisely so two dialling files could not drift on
 * the ceiling — and they drifted anyway, because the FUNCTION stayed duplicated: `search.ts` called
 * `answerTooLarge(headers)` with no argument, taking the 4 MB sync-page default for an answer of a
 * few hundred channel names. A shared constant that each caller may forget to pass is a shared
 * constant in name only. Both the rule AND the call now live in one place.
 *
 * ⚠️ **Every failure collapses to `undefined` on purpose.** A peer that is offline, slow, speaking a
 * different version, over its ceiling or answering unparseable JSON is the ORDINARY case out here,
 * and none of it may abort the caller — a search is asking several peers at once, and one bad
 * answer must not lose the others. Callers turn `undefined` into their own empty value.
 * ⚠️ That is also why this returns no reason: it is not a mutation, so ruling 2 is not in play. A
 * caller that needs to TELL someone a dial failed must not use this.
 */
export const askPeerJson = <A, I>(input: {
  readonly http: HttpClient.HttpClient
  readonly route: string
  readonly path: string
  readonly schema: Schema.Codec<A, I>
  readonly timeoutMs: number
  /** The limit for THIS route. Required — the default is what drifted; make every caller state it. */
  readonly ceilingBytes: number
  readonly body?: unknown
  readonly method?: "POST" | "GET"
}): Effect.Effect<A | undefined> => {
  const url = `${input.route.replace(/\/+$/, "")}${input.path}`
  const request =
    (input.method ?? "POST") === "GET"
      ? HttpClientRequest.get(url)
      : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(input.body))
  return input.http.execute(request).pipe(
    Effect.timeout(input.timeoutMs),
    Effect.flatMap((response) =>
      /**
       * ⚠️ Refused on the DECLARED length, before the body is read — the only place the check can
       * happen before the allocation it exists to prevent. An answer with no declared length is
       * refused for the same reason the inbound limiter refuses one: every honest responder here is
       * a NovaClaw instance answering with a JSON string, which always sets it, and a peer that
       * omits it is asking us to read an unknown quantity on trust.
       */
      answerTooLarge(response.headers, input.ceilingBytes)
        ? Effect.fail(new Error("peer answer too large"))
        : response.json,
    ),
    Effect.flatMap((json) => Schema.decodeUnknownEffect(input.schema)(json)),
    Effect.map((value): A | undefined => value),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
}

/**
 * 🔴 What a PERSON types, turned into routes we can dial.
 *
 * `httpRoutes` requires a full URL, which is right for routes learned from mDNS or peer exchange —
 * they always carry a scheme. It is wrong for a human: `new URL("127.0.0.1:4097")` parses with
 * protocol `127.0.0.1:`, so a typed address was filtered out and the caller answered "nothing lives
 * there" about a host that was answering perfectly. Found by typing an IP into the box.
 *
 * ⚠️ HTTPS is tried FIRST and http is the fallback, never the other way round. Preferring the
 * plaintext form would silently downgrade every public host somebody pastes; the fallback exists
 * because the common case on a LAN is a plain port, and refusing that would make the doorman door
 * unusable exactly where it is needed most.
 */
export const typedRoutes = (address: string): string[] => {
  const trimmed = address.trim()
  if (trimmed === "") return []
  // ⚠️ The SAME validator every other route goes through (`route.ts`), not a scheme check: a typed
  // address is still an address, and "the user typed it" is not a reason to dial a URL carrying a
  // query, a fragment or userinfo.
  const already = CommunityRoute.dialable(trimmed)
  if (already !== undefined) return [already]
  // Anything that cannot be a host is not worth two dials.
  if (!/^[A-Za-z0-9._\-]+(:\d{1,5})?(\/.*)?$/.test(trimmed)) return []
  // ⚠️ And the two candidates go through the validator as well. That regex's `(\/.*)?` tail accepts
  // `?` and `#`, so a typed `example.com/a?x=` would otherwise become a dialable route carrying a
  // query — the same injection as 1.3, entering through the one door that is supposed to be for
  // humans.
  return CommunityRoute.dialableAll([`https://${trimmed}`, `http://${trimmed}`])
}

/**
 * Every route in this list we are willing to dial.
 *
 * ⚠️ **This used to be the only validator, and it checked the SCHEME** — which is finding 1.3: a
 * route ending in `#` or `?x=` passed it and then put our API path into the fragment or query. It
 * now delegates to `CommunityRoute`, so the name survives for its callers while the rule is the one
 * rule.
 */
export const httpRoutes = (routes: readonly string[]): string[] => CommunityRoute.dialableAll(routes)

/** How long to wait on one peer. A slow peer must never hold up the others. */
const PER_PEER_TIMEOUT_MS = 8_000

/**
 * 🔴 How many peers we dial AT ONCE.
 *
 * The peer table is bounded at 500, and this fan-out was `"unbounded"` — so posting a single message
 * could open five hundred simultaneous connections from a laptop. Our OWN ceiling feeding an
 * unlimited fan-out, which is the same mistake as trusting a peer's number, made against ourselves:
 * an attacker who fills the peer table to its legitimate bound turns every message the user sends
 * into a socket storm on their own machine.
 *
 * ⚠️ 8, because the work is network-bound and the failure is exhaustion rather than slowness. Every
 * peer is still dialled; they are dialled in batches, and a message reaching its audience a moment
 * later is not a cost anyone can perceive.
 */
const FANOUT = 8

/**
 * 🔴 **How many ROUTES one publish attempts, and how long the whole thing may take** — review §2
 * (unit 3 F16).
 *
 * `publish` walked every route of every reachable peer with no deadline. The peer table holds up to
 * 500 rows and eight routes each, so one `say` could open **4,000 POSTs**; at eight at a time and an
 * 8 s timeout, the worst case is over an hour of a user's machine talking to nobody, for a message
 * that was already stored locally before any of it started.
 *
 * ⚠️ A bounded fan-out is not a lost message, and that is what makes this the right shape rather
 * than a compromise: gossip reaches whoever is online, and reconciliation is what catches everyone
 * else up — `sync` exists precisely because publishing cannot promise delivery. Widening the blast
 * radius past this buys reach that the catch-up path already provides, at a cost the sender pays.
 *
 * ⚠️ Contacts come first in the reachable list, so the cut falls on strangers rather than on the
 * people the user actually added.
 */
export const MAX_PUBLISH_TARGETS = 64

/** The whole broadcast's budget. One `say` must not be able to hold the machine for minutes. */
export const PUBLISH_TOTAL_MS = 15_000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service
    // 🔴 `speaks()` rather than the airgap alone: an instance that has not JOINED must not reach out
    // either. Gating only the inbound door was the first attempt and it left the bigger half open —
    // outbound connections are precisely what reveal the user's IP to a stranger, which is the thing
    // the warning they accepted is about. `participates` covers BOTH conditions, and reads each live.
    const speaks = () => CommunityConsent.participates(CommunityConsent.currentGate())
    const contacts = yield* CommunityContacts.Service
    const peers = yield* CommunityPeers.Service
    const http = yield* HttpClient.HttpClient

    /**
     * Peers we could actually dial: known, not blocked, and carrying an HTTP route.
     *
     * ⚠️ Blocked contacts are excluded from SENDING too, not only from receiving. Publishing to
     * someone whose messages you refuse tells them you are online and hands them your traffic — the
     * block would be one-directional in the direction that helps them.
     */
    const reachable = Effect.fn("CommunityTransportHttp.reachable")(function* (limit?: number) {
      /**
       * 🔴 Contacts AND discovered peers. Caught by running it: discovery learned an instance from
       * its address, the peer table held it, and the transport still reported `no-peers` — so the
       * network could be found and not spoken to. Publishing only to hand-added contacts would make
       * peer exchange pointless, since everything it learns lands in the peer table by design.
       *
       * ⚠️ A peer is still not a contact. This grants no trust: it is a list of places to send a
       * signed, work-proven message that every receiver judges on its own terms.
       */
      /**
       * 🔴 ONE builder, shared with `sync` and `search` (review 1.9). This function used to union a
       * BLOCK-FILTERED `contacts.bootstrap()` with an UNFILTERED `peers.list()`, so a blocked peer
       * still contributed a route and `publish` sent them the user's own messages — observed on the
       * wire as `POST /blocked/api/community/inbound`. Six broadcast paths each built their own list;
       * fixing one of them was never going to be the mechanism.
       */
      return yield* CommunityReach.reachable({ contacts, peers, ...(limit === undefined ? {} : { limit }) })
    })

    const state = Effect.fn("CommunityTransportHttp.state")(function* () {
      // A live getter over the process-wide ref, so a Settings change takes effect without a restart.
      // The airgap gate stays FIRST: a community feature is egress the user chose, and airgap has to
      // be able to withdraw that choice before anything else is considered.
      /**
       * ⚠️ The two reasons are told APART. Folding "has not joined" into "airgap" was a one-line
       * convenience that made this surface lie: it is read by the agent tool's `status` and by the
       * API, and a user shown "offline mode is on" when it is not would go and look for a switch
       * that is already off. The same argument the refusals ARRAY makes, one layer down.
       */
      if (CommunityConsent.currentGate().airgap) return { kind: "off", reason: "airgap" } as const
      if (!speaks()) return { kind: "off", reason: "not-joined" } as const
      const peers = yield* reachable()
      // ⚠️ Not `off/none`: the transport exists and works. "We know nobody to dial" is a different
      // sentence to a person than "this is not built yet", and it is one they can fix in a minute.
      /**
       * ⚠️ Distinct PEOPLE, not routes. One instance reachable at a LAN address and a loopback
       * address is one peer with two ways in, and reporting "2 peers" would tell a user there are
       * others out there when there is exactly one — the sort of small lie this UI is not allowed to
       * tell. Seen live: a single discovered instance reported as two.
       */
      const distinct = new Set(peers.map((peer) => peer.networkID))
      return distinct.size === 0
        ? ({ kind: "off", reason: "no-peers" } as const)
        : ({ kind: "online", peers: distinct.size } as const)
    })

    return Service.of({
      state,

      publish: Effect.fn("CommunityTransportHttp.publish")(function* (message: CommunityMessage.Proven) {
        if (!speaks()) return false
        const peers = yield* reachable(MAX_PUBLISH_TARGETS)
        if (peers.length === 0) return false

        /**
         * ⚠️ Addressed by TOPIC, never by the channel NAME. The receiver resolves a topic against the
         * channels IT joined, so a peer that spells the room differently still resolves it — and a
         * peer that never joined it cannot store it at all, which is the `not-subscribed` rule
         * holding by arithmetic rather than by trust in the sender.
         */
        const body = { topic: CommunityTopic.topicOf(message.channel), message }

        /**
         * 🔴 Every peer is attempted, and one peer's failure is not the publish's failure. Offline
         * peers are the NORMAL case in a network of home machines, so an unreachable contact must
         * cost this call a timeout and nothing else. Each attempt is made total BEFORE `Effect.all`
         * sees it, so one refused connection cannot cancel its siblings.
         */
        const attempts = yield* Effect.all(
          peers.map((peer) =>
            http
              .execute(
                HttpClientRequest.post(`${peer.route.replace(/\/+$/, "")}${INBOUND_PATH}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe(body),
                ),
              )
              .pipe(
                Effect.timeout(PER_PEER_TIMEOUT_MS),
                Effect.map((response) => response.status >= 200 && response.status < 300),
                /**
                 * 🔴 Each attempt is made TOTAL here rather than at the end, and that is what keeps
                 * `publish` unable to fail. An unreachable contact is the ordinary state of a network
                 * of home machines — a refused connection, a DNS miss, an expired certificate — and
                 * none of those is an error the user should ever see. They are one peer that did not
                 * answer.
                 */
                Effect.catchCause(() => Effect.succeed(false)),
              ),
          ),
          { concurrency: FANOUT },
        ).pipe(
          /**
           * 🔴 The whole broadcast's deadline. Every attempt is already total and already has its
           * own timeout, so this bounds the SUM — the number a user feels when they press send.
           *
           * ⚠️ Timing out is reported as "nobody carried it", which is honest: the message is in our
           * own log either way (`post` stored it before this was called), and whoever we did not
           * reach gets it from reconciliation. Claiming delivery for an abandoned batch would be the
           * lie `say`'s own wording exists to avoid.
           */
          Effect.timeoutOrElse({
            duration: PUBLISH_TOTAL_MS,
            orElse: () => Effect.succeed([] as boolean[]),
          }),
        )

        // True when ANY peer took it. The caller has already stored its own copy, so this reports
        // whether the message found an audience — never whether it survived.
        return attempts.some((accepted) => accepted)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [
    /**
     * 🔴 Installs the consent gate wherever the transport is BUILT, not only in the server graph.
     *
     * Found by driving a real agent on another machine: the instance had joined — the row was in its
     * database — and `novaclaw run` still refused, because the gate was registered in the HTTP
     * server's graph alone. Any process that did not build that graph read the safe default and
     * reported "has not joined", which is indistinguishable from a user who never accepted.
     *
     * ⚠️ Here rather than on each caller: the transport is what every outbound path goes through, so
     * a graph that can speak necessarily installs the gate that decides whether it may.
     */
    CommunityConsent.node,
  Offline.node,
  CommunityChannels.node,
  CommunityContacts.node,
  CommunityPeers.node,
  // ⚠️ The SHARED httpClient node, never a private fetch client: it is the OFF-A offline chokepoint,
  // so airgap is enforced a second time and independently of the explicit check above.
  httpClient,
] })
