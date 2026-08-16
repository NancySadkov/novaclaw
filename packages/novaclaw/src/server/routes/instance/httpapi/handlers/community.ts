import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { MDNS } from "@/server/mdns"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunitySeeds } from "@novaclaw/core/community/seeds"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { CommunityTopic } from "@novaclaw/core/community/topic"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { LLM, LLMClient, LLMEvent, Message, SystemPart } from "@novaclaw/llm"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { llmClient } from "@novaclaw/core/effect/app-node-platform"
import { Effect, Option, Semaphore, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

/**
 * Community P3/P4 — the forum's HTTP surface (`todo/community-p2p.md`).
 *
 * Thin on purpose. Every rule about what may be stored lives in the stores — one ingress door, so a
 * second caller cannot arrive later with its own idea of what counts as a valid contact or message.
 */
export const communityHandlers = HttpApiBuilder.group(InstanceHttpApi, "community", (handlers) =>
  Effect.gen(function* () {
    const contacts = yield* CommunityContacts.Service
    const channels = yield* CommunityChannels.Service
    // Answering is a narrower permission than participating, and the panel shows both together.
    const answers = yield* CommunityAnswer.Service
    const sync = yield* CommunitySync.Service
    const identity = yield* InstanceIdentityStore.Service
    const search = yield* CommunitySearch.Service
    const direct = yield* CommunityDirect.Service
    const offers = yield* CommunityOffer.Service
    const peersStore = yield* CommunityPeers.Service
    const transport = yield* CommunityTransport.Service
    const posts = yield* CommunityPost.Service

    return handlers
      .handle(
        "contactList",
        Effect.fn("CommunityHttpApi.contactList")(function* () {
          return yield* contacts.list()
        }),
      )
      .handle(
        "contactAdd",
        Effect.fn("CommunityHttpApi.contactAdd")(function* (ctx) {
          // The store owns the "is this actually a public key" rule; the handler only translates
          // its refusal into an HTTP one rather than re-deciding it here.
          return yield* contacts
            .add({
              networkID: ctx.payload.networkID,
              ...(ctx.payload.petname === undefined ? {} : { petname: ctx.payload.petname }),
              ...(ctx.payload.routes === undefined ? {} : { routes: ctx.payload.routes }),
            })
            .pipe(
              Effect.catchTag("CommunityContacts.ContactError", (error) =>
                Effect.fail(new InvalidRequestError({ message: error.message })),
              ),
            )
        }),
      )
      .handle(
        "contactForget",
        Effect.fn("CommunityHttpApi.contactForget")(function* (ctx) {
          return yield* contacts.forget(ctx.params.networkID)
        }),
      )
      .handle(
        "contactBlock",
        Effect.fn("CommunityHttpApi.contactBlock")(function* (ctx) {
          return yield* contacts.setBlocked(ctx.params.networkID, ctx.payload.blocked)
        }),
      )
      .handle(
        "transportState",
        Effect.fn("CommunityHttpApi.transportState")(function* () {
          return yield* transport.state()
        }),
      )
      .handle(
        "channelList",
        Effect.fn("CommunityHttpApi.channelList")(function* () {
          return yield* channels.channels()
        }),
      )
      .handle(
        "channelJoin",
        Effect.fn("CommunityHttpApi.channelJoin")(function* (ctx) {
          /**
           * 🔴 A room name is an identifier and cannot carry control characters. The name reaching
           * here came from a stranger — advertised, shown in discovery, joined with one click — and
           * only its LENGTH was ever checked, so a peer could advertise a room whose name is three
           * lines of text that read as a conversation turn.
           *
           * ⚠️ Refused rather than cleaned: stripping characters changes the name, the name is
           * hashed to the topic, and the user would silently join a DIFFERENT room from the one they
           * clicked on. Told, so they know why.
           */
          if (!CommunityChannels.isPlainChannelName(ctx.payload.name))
            return yield* Effect.fail(
              new InvalidRequestError({
                message: "A channel name cannot contain line breaks or control characters.",
              }),
            )
          yield* channels.join(ctx.payload.name)
          return yield* channels.channels()
        }),
      )
      .handle(
        "communityRotate",
        Effect.fn("CommunityHttpApi.communityRotate")(function* () {
          /**
           * 🔴 Exposed only now that a transport exists. The ledger held rotation back precisely
           * because "a successor statement no peer can receive would strand the user" — until P2
           * there was nobody to receive it, so issuing one would have quietly orphaned the user from
           * everyone who knew them.
           */
          const rotated = yield* identity.rotate()
          // Announce AND collect in one pass: the peers worth telling are the ones worth asking.
          const spread = yield* sync.successions(rotated.statement)
          return { networkID: rotated.identity.networkID, told: spread.told }
        }),
      )
      .handle(
        "communityDoorman",
        Effect.fn("CommunityHttpApi.communityDoorman")(function* (ctx) {
          /**
           * 🔴 The USER is making this relationship, which is why a contact may be created here.
           *
           * (ff): autonomy may deepen a relationship the user made and may never make one —
           * `observe` and `follow` both refuse to mint a contact from anything the network says.
           * This is the opposite case: a person typed an address and stated how far they trust who
           * is behind it. Refusing to record that would be enforcing a rule against the only party
           * it exists to protect.
           */
          const who = yield* sync.identify(ctx.payload.address)
          if (who === undefined) return { found: false }

          // The route first, so the contact has somewhere to be reached even before any gossip.
          yield* peersStore.learn(who.networkID, [who.route], "manual")
          /**
           * 🔴 A malformed identity is NOT FOUND, not a crash and not an error page.
           *
           * The key came from the far end, not from the user — so a peer serving nonsense there is
           * an ordinary hostile case, and dying on it would let anyone with an address take this
           * endpoint down. `add` refuses an id that cannot parse as a public key, which is exactly
           * the check we want; what changes here is only that its refusal reads as "nobody usable
           * lives there".
           */
          const added = yield* contacts
            .add({
              networkID: who.networkID,
              routes: [who.route],
              trust: ctx.payload.trust,
              ...(ctx.payload.petname === undefined ? {} : { petname: ctx.payload.petname }),
            })
            .pipe(Effect.catchTag("CommunityContacts.ContactError", () => Effect.succeed(undefined)))
          if (added === undefined) return { found: false }
          return { found: true, networkID: who.networkID }
        }),
      )
      .handle(
        "communityDiscover",
        Effect.fn("CommunityHttpApi.communityDiscover")(function* (ctx) {
          /**
           * 🔴 Every source at once, because plurality IS the anti-shutdown property. The spec: if
           * everyone ships the same three seeds and they die, new users cannot join a network that is
           * perfectly alive. LAN costs nothing and needs no seed at all.
           */
          const found = yield* Effect.promise(() => MDNS.browse())
          const lan = found.map((entry) => entry.url)
          const supplied = ctx.payload.addresses ?? []
          // ⚠️ Sightings first, PX second, and in that order deliberately: a peer learned from the
          // LAN this second is someone we can immediately ask for more.
          /**
           * 🔴 The DEFAULT door, for a user who knows nobody and is not on a LAN with anyone.
           *
           * Without this, "clicking Community joins the network" was true only beside another
           * instance or for somebody who had been handed an address — an invitation-only club,
           * which is the opposite of the point.
           *
           * ⚠️ Best-effort and silent: no seeds, no error, join anyway. A lookup that could fail
           * a join would make the seeds a DEPENDENCY, and the whole argument for allowing a
           * centralised seed at all is that it is a convenience the network survives losing.
           */
          const stored = CommunityConsent.storedConfig() as
            | { community?: { seeds?: { enabled?: boolean; host?: string } } }
            | undefined
          const seeds = yield* CommunitySeeds.resolve({
            ...(stored?.community?.seeds === undefined ? {} : { settings: stored.community.seeds }),
          })

          yield* sync.learnFrom(lan, "lan")
          yield* sync.learnFrom(seeds, "dns")
          yield* sync.learnFrom(supplied, "manual")
          const exchange = yield* sync.discover()
          return { learned: exchange.learned, asked: exchange.asked, peers: (yield* peersStore.list()).length }
        }),
      )
      .handle(
        "channelArchived",
        Effect.fn("CommunityHttpApi.channelArchived")(function* () {
          return yield* channels.archived()
        }),
      )
      .handle(
        "channelLeave",
        Effect.fn("CommunityHttpApi.channelLeave")(function* (ctx) {
          // ⚠️ The store deliberately keeps the history. Leaving is a subscription change, not a
          // deletion, and rejoining must not present an empty room the user knows had messages.
          return yield* channels.leave(ctx.params.name)
        }),
      )
      .handle(
        "channelMute",
        Effect.fn("CommunityHttpApi.channelMute")(function* (ctx) {
          return yield* channels.setMuted(ctx.params.name, ctx.payload.muted)
        }),
      )
      .handle(
        "channelListed",
        Effect.fn("CommunityHttpApi.channelListed")(function* (ctx) {
          return yield* channels.setListed(ctx.params.name, ctx.payload.listed)
        }),
      )
      .handle(
        "filterList",
        Effect.fn("CommunityHttpApi.filterList")(function* () {
          return yield* channels.filters()
        }),
      )
      .handle(
        "filterAdd",
        Effect.fn("CommunityHttpApi.filterAdd")(function* (ctx) {
          return yield* channels.filter(ctx.payload.pattern)
        }),
      )
      .handle(
        "filterRemove",
        Effect.fn("CommunityHttpApi.filterRemove")(function* (ctx) {
          return yield* channels.unfilter(ctx.payload.pattern)
        }),
      )
      .handle(
        "channelsNearby",
        Effect.fn("CommunityHttpApi.channelsNearby")(function* () {
          return yield* sync.channelsNearby()
        }),
      )
      .handle(
        "communityParticipation",
        Effect.fn("CommunityHttpApi.communityParticipation")(function* () {
          const gate = CommunityConsent.currentGate()
          const answering = yield* answers.state()
          return {
            participating: CommunityConsent.participates(gate),
            consented: gate.consented,
            enabled: gate.enabled,
            refusals: CommunityConsent.refusals(gate),
            answers: {
              enabled: answering.gate.enabled,
              perDay: answering.gate.perDay,
              today: answering.today,
            },
          }
        }),
      )
      .handle(
        "offerMineRead",
        Effect.fn("CommunityHttpApi.offerMineRead")(function* () {
          return yield* offers.mineStored()
        }),
      )
      .handle(
        "offerPublish",
        Effect.fn("CommunityHttpApi.offerPublish")(function* (ctx) {
          /**
           * 🔴 Told, not silently dropped. `verify` refuses an endpoint that is not an http(s) URL
           * on every READ — which is right for an offer already on disk, and wrong as the only
           * feedback a user gets: the POST used to answer 200 with the offer echoed back while
           * nothing was ever served to anybody.
           */
          if (!CommunityOffer.isServableEndpoint(ctx.payload.endpoint))
            return yield* Effect.fail(
              new InvalidRequestError({
                message: "An offer's endpoint must be an http:// or https:// URL — that is what peers will connect to.",
              }),
            )
          // ⚠️ Same reasoning one field over, and this one is money: `payTo` lands on somebody's
          // clipboard verbatim, so a stray space or a look-alike letter is not a cosmetic problem.
          if (!CommunityOffer.isPayableAddress(ctx.payload.payTo ?? ""))
            return yield* Effect.fail(
              new InvalidRequestError({
                message:
                  "A payment address must be plain ASCII with no spaces — it goes on the clipboard exactly as written.",
              }),
            )
          return yield* offers.publish({
            kind: "model-server",
            ...ctx.payload,
            payTo: ctx.payload.payTo ?? "",
          })
        }),
      )
      .handle(
        "offerWithdraw",
        Effect.fn("CommunityHttpApi.offerWithdraw")(function* () {
          yield* offers.withdraw()
          return true
        }),
      )
      .handle(
        "offersKnown",
        Effect.fn("CommunityHttpApi.offersKnown")(function* () {
          return yield* offers.known()
        }),
      )
      .handle(
        "directSend",
        Effect.fn("CommunityHttpApi.directSend")(function* (ctx) {
          return yield* sync.sendDirect(ctx.params.networkID, ctx.payload.body)
        }),
      )
      .handle(
        "directHistory",
        Effect.fn("CommunityHttpApi.directHistory")(function* (ctx) {
          return yield* direct.history(ctx.params.networkID)
        }),
      )
      .handle(
        "directList",
        Effect.fn("CommunityHttpApi.directList")(function* () {
          return yield* direct.conversations()
        }),
      )
      .handle(
        "searchChannels",
        Effect.fn("CommunityHttpApi.searchChannels")(function* (ctx) {
          return yield* search.search(ctx.payload.terms)
        }),
      )
      .handle(
        "channelPost",
        Effect.fn("CommunityHttpApi.channelPost")(function* (ctx) {
          const result = yield* posts.post(ctx.params.name, ctx.payload.body)
          return { id: result.message.signature, stored: result.stored, delivered: result.delivered }
        }),
      )
      .handle(
        "channelHistory",
        Effect.fn("CommunityHttpApi.channelHistory")(function* (ctx) {
          return yield* channels.historyFiltered(ctx.params.name)
        }),
      )
      /**
       * 🔴 The wire that was missing. `reconcile.ts` and `sync.sync` were written, bounded, reviewed
       * and tested — and then nothing in a running instance ever called them, so a joining instance
       * held only what arrived live after it got there. Measured on two real instances: A held 601
       * messages, B joined, and B received the next live post and NONE of the backlog.
       *
       * ⚠️ On demand rather than a background timer. Catch-up is `peers × round trips`, and the whole
       * subsystem is careful about what a peer's answer costs us; a timer would pay that repeatedly
       * for channels nobody is reading. The app asks when a channel is opened, which is exactly when
       * the history is about to be looked at.
       */
      .handle(
        "channelSync",
        Effect.fn("CommunityHttpApi.channelSync")(function* (ctx) {
          return yield* sync.sync(ctx.params.name)
        }),
      )
  }),
)

/**
 * Community P2 — the peer ingress handler.
 *
 * 🔴 Everything it does is hand the payload to `CommunityChannels.deliver` and answer the same way
 * regardless. `deliver` is the ONE door where work, signature, subscription, block, size and
 * duplicate rules live; a handler that pre-screened here would be a second door with a subset of
 * them, and the subset is what gets forgotten.
 */
export const communityPeerHandlers = HttpApiBuilder.group(InstanceHttpApi, "communityPeer", (handlers) =>
  Effect.gen(function* () {
    const channels = yield* CommunityChannels.Service
    const peers = yield* CommunityPeers.Service
    const contacts = yield* CommunityContacts.Service
    const successions = yield* CommunitySuccession.Store
    const search = yield* CommunitySearch.Service
    const direct = yield* CommunityDirect.Service
    const offers = yield* CommunityOffer.Service
    // ⚠️ Acquired in THIS group, not borrowed from the authenticated one above — both scopes bind
    // names like `channels` and `identity`, so a handler placed in the wrong block still compiles
    // against the other group's service. That mistake has been made three times in this file.
    const selfIdentity = yield* InstanceIdentityStore.Service
    const answers = yield* CommunityAnswer.Service
    const ledger = yield* CommunityObservation.Service
    /**
     * 🔴 ONE answering turn at a time, and a request that cannot have it is refused rather than
     * queued.
     *
     * The budget bounds what we SPEND; it does not bound what a stranger can tie up. An inline model
     * call holds a connection for seconds, so without this a handful of askers occupy every worker
     * while the daily count is still nearly untouched — the cost lands on the owner's own machine,
     * which is the half a token budget cannot see.
     *
     * ⚠️ Refused, not queued: a queue turns "we are busy" into an unbounded wait, which is the
     * same denial with a longer timeout.
     */
    const turn = Semaphore.makeUnsafe(1)

    /**
     * Resolve a topic to one of OUR channels, or nothing.
     *
     * ⚠️ Every sync handler answers empty for an unresolvable topic rather than erroring. A hash
     * cannot be inverted, so "not one of ours" and "ours but empty" look identical to the asker —
     * which is deliberate: a peer must not be able to map this instance's rooms by walking topics.
     */
    const roomFor = Effect.fn("CommunityHttpApi.roomFor")(function* (topic: string) {
      const joined = yield* channels.channels()
      return CommunityTopic.channelFor(
        topic,
        joined.map((entry) => entry.name),
      )
    })

    return handlers
      .handle(
        "communityDirectMessage",
        Effect.fn("CommunityHttpApi.communityDirectMessage")(function* (ctx) {
          // The verdict is dropped, as on the channel door: reporting it would tell a stranger
          // whether they are blocked, and whether this instance holds the key they sealed to.
          yield* direct.receive(ctx.payload)
          return { received: true } as const
        }),
      )
      .handle(
        "communitySearch",
        Effect.fn("CommunityHttpApi.communitySearch")(function* (ctx) {
          return { channels: yield* search.receive(ctx.payload) }
        }),
      )
      .handle(
        "communityAsk",
        Effect.fn("CommunityHttpApi.communityAsk")(function* (ctx) {
          /**
           * 🔴 The permission and the budget are checked BEFORE a model is resolved, let alone
           * called. Resolving reads a catalog and a credential — cheap, but not free, and doing it
           * for a request we were never going to answer is work a stranger got for nothing.
           */
          /**
           * 🔴 VERIFIED FIRST, before the gate, the budget or anything else reads `asker`.
           *
           * An unverified asker makes the per-peer budget evadable by varying a string, and makes the
           * dealing we record on answering an assertion about whoever the sender named — which is
           * the third-party bad-mouthing the ledger's own engagement bound exists to stop.
           */
          /**
           * 🔴 Cheapest refusal first, and the ASKER is not read until it is proven.
           *
           * `state()` answers not-joined, not-answering and budget-spent without touching the asker
           * at all — a config read and one count. Doing it before the signature means an instance
           * with answering switched off does NO cryptography for a flood, which the live probe made
           * obvious: a valid question got "not-answering" only after a verification nobody needed.
           *
           * ⚠️ The per-asker share is checked AFTER verification, and that ordering is the point.
           * It is the one refusal keyed on who is asking, so consulting it for an unproven identity
           * would let a stranger probe whether a peer they name has used up their share.
           */
          const overall = yield* answers.state()
          if (overall.refusal !== undefined) return { refused: overall.refusal }

          if (!CommunityAnswer.verifyAsk(ctx.payload)) return { refused: "unsigned" as const }

          const refusal = yield* answers.allowed(ctx.payload.asker)
          if (refusal !== undefined) return { refused: refusal }

          const answer = yield* turn
            .withPermitsIfAvailable(1)(
              Effect.gen(function* () {
                const models = yield* SessionRunnerModel.Service
                const llm = yield* LLMClient.Service
                // ⚠️ BOUNDED, for the reason the memory handler records: resolving does not call the
                // model, so it is fast or it is stuck, and a stuck resolve here would hold a stranger's
                // connection open indefinitely.
                const model = yield* models
                  .resolveDefault()
                  .pipe(
                    Effect.timeoutOrElse({
                      duration: "30 seconds",
                      orElse: () => Effect.die("resolveDefault timed out"),
                    }),
                  )
                const chunks: string[] = []
                yield* llm
                  .stream(
                    LLM.request({
                      model,
                      system: [SystemPart.make(CommunityAnswer.SYSTEM)],
                      // 🔴 FRAMED. The question is a stranger's words entering a model's context, and
                      // this one is more dangerous than a channel body because the model is SUPPOSED
                      // to act on it.
                      messages: [Message.user(CommunityAnswer.framedQuestion(ctx.payload.question))],
                      // 🔴 NO TOOLS. An instance that answers strangers with a full agent is a remote
                      // shell with extra steps; what it may use is what it would say aloud in a room.
                      tools: [],
                      generation: { maxTokens: 512 },
                    }),
                  )
                  .pipe(
                    Stream.runForEach((event) => {
                      if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
                      return Effect.void
                    }),
                  )
                return chunks.join("") as string | undefined
              }).pipe(
                Effect.provide(AppNodeBuilder.build(llmClient)),
                /**
                 * 🔴 A model we cannot reach is a REFUSAL, not a 500.
                 *
                 * Found by turning answering on where no model is configured: every asker got an
                 * opaque UnknownError with a diagnostic reference, which tells a stranger nothing,
                 * tells the owner nothing, and reads as a broken instance rather than one that
                 * cannot answer right now. §4d says a refusal is a normal answer and must be NAMED.
                 *
                 * ⚠️ It also has to be caught here rather than at the edge, because the failure
                 * is somebody else's request holding OUR permit — dying inside the semaphore is
                 * how a transient model problem becomes a stuck door.
                 */
                Effect.catchCause(() => Effect.succeed(undefined)),
              ),
            )

          // Nobody got the permit: somebody else's question is being answered right now.
          if (Option.isNone(answer)) return { refused: "busy" as const }
          // ⚠️ Distinct from "no-answer": the model never ran, rather than running and saying nothing.
          if (answer.value === undefined) return { refused: "unavailable" as const }
          const text = answer.value.trim()
          // An empty completion is a broken call, not an answer worth signing our name to.
          if (text === "") return { refused: "no-answer" as const }

          /**
           * ⚠️ Spent AFTER the answer exists, so a failed turn does not consume the day — and
           * the dealing is recorded because answering IS one. `record` refuses subjects we have never
           * encountered, so a first-time asker simply leaves no ledger entry; the SPEND is counted
           * either way, because what we spend is always our own business.
           */
          yield* answers.spent(ctx.payload.asker)
          /**
           * 🔴 FIRST-HAND, so the dealing is actually recorded.
           *
           * `record` refuses subjects this instance has never encountered — the defence against an
           * agent being told to write about strangers. A FIRST-TIME asker is a stranger by
           * definition, so routing this through it meant every one of them was silently dropped and
           * the vision's *"answering is a dealing recorded on both sides"* was false for exactly the
           * population it matters for. Found by asking what the store did with a key it had never
           * seen, rather than by any test.
           */
          yield* ledger.recordFirstHand({
            subject: ctx.payload.asker,
            at: Date.now(),
            context: "answer",
            outcome: "answered",
          })
          /**
           * 🔴 SIGNED, which is what makes the system prompt's claim true.
           *
           * The prompt tells the model its answer is signed with its user's identity and that a
           * careless one costs their standing — the only reason it is given to be careful. That was
           * false for as long as the reply carried no signature, and a false reason is worse than
           * none.
           *
           * ⚠️ The ASKER and the QUESTION are inside the signature, not just the answer: without
           * the asker, our reply to one peer could be replayed as our reply to another; without the
           * question, the claim is unfalsifiable and cannot be re-examined by anyone it is repeated to.
           */
          const at = Date.now()
          const unsigned = {
            author: (yield* selfIdentity.identity()).networkID,
            asker: ctx.payload.asker,
            question: ctx.payload.question,
            answer: text,
            at,
          }
          const signature = yield* selfIdentity.sign(CommunityAnswer.canonicalBytes(unsigned))
          return { answer: text, author: unsigned.author, at, signature: signature.toString("base64url") }
        }),
      )
      .handle(
        "communitySuccessionTell",
        Effect.fn("CommunityHttpApi.communitySuccessionTell")(function* (ctx) {
          // Kept AND applied: remembering lets us tell others, following moves our own contact.
          yield* successions.remember(ctx.payload)
          yield* contacts.followAll([ctx.payload])
          return { received: true } as const
        }),
      )
      .handle(
        "communitySuccessionKnown",
        Effect.fn("CommunityHttpApi.communitySuccessionKnown")(function* () {
          return { statements: yield* successions.known() }
        }),
      )
      .handle(
        "communityIdentity",
        Effect.fn("CommunityHttpApi.communityIdentity")(function* () {
          const self = yield* selfIdentity.identity()
          // Minted on first request and kept, so one fetch teaches a peer both halves of who lives
          // here — the identity to verify against, and the key to seal to.
          const sealing = yield* selfIdentity.sealingKey()
          return { networkID: self.networkID, sealingKey: sealing.publicKey, sealingSignature: sealing.signature }
        }),
      )
      .handle(
        "communityOffer",
        Effect.fn("CommunityHttpApi.communityOffer")(function* () {
          const mine = yield* offers.mine()
          return mine === undefined ? {} : { offer: mine }
        }),
      )
      .handle(
        "communityListed",
        Effect.fn("CommunityHttpApi.communityListed")(function* () {
          // Only what the user chose to disclose — never `channels()`.
          return { channels: yield* channels.listed() }
        }),
      )
      .handle(
        "communityPeers",
        Effect.fn("CommunityHttpApi.communityPeers")(function* () {
          const offered = yield* peers.sample()
          return { peers: offered.map((peer) => ({ networkID: peer.networkID, routes: peer.routes })) }
        }),
      )
      .handle(
        "communitySyncSummary",
        Effect.fn("CommunityHttpApi.communitySyncSummary")(function* (ctx) {
          const room = yield* roomFor(ctx.payload.topic)
          /**
           * 🔴 `summarize([])`, NOT `[]`. Caught by probing the running instance, against a comment
           * three lines up that claimed the two were indistinguishable: an empty ARRAY is 0 buckets
           * while a joined-but-empty channel is 64 empty digests, so a prober could tell "not
           * subscribed" from "subscribed, nothing said" at a glance — exactly the map this endpoint
           * refuses to draw. It is also wrong functionally: `differing` treats a summary of another
           * LENGTH as wholly different, so every sync against a peer outside the room would request
           * all 64 buckets.
           */
          const ids = room === undefined ? [] : yield* channels.ids(room)
          return { buckets: CommunityReconcile.summarize(ids) }
        }),
      )
      .handle(
        "communitySyncIds",
        Effect.fn("CommunityHttpApi.communitySyncIds")(function* (ctx) {
          const room = yield* roomFor(ctx.payload.topic)
          if (room === undefined) return { ids: [] }
          return { ids: CommunityReconcile.idsIn(yield* channels.ids(room), ctx.payload.buckets) }
        }),
      )
      .handle(
        "communitySyncMessages",
        Effect.fn("CommunityHttpApi.communitySyncMessages")(function* (ctx) {
          const room = yield* roomFor(ctx.payload.topic)
          if (room === undefined) return { messages: [] }
          // ⚠️ Bounded here as well as by the asker: a request naming every retained id would have us
          // assemble it all in memory, which is cheap for them and repeatable.
          const wanted = ctx.payload.ids.slice(0, CommunitySync.MAX_MESSAGES_PER_REQUEST)
          const found = yield* channels.byIDs(room, wanted)
          return {
            messages: found.map((message) => ({
              channel: message.channel,
              author: message.author,
              at: message.at,
              body: message.body,
              signature: message.signature,
              nonce: message.nonce,
            })),
          }
        }),
      )
      .handle(
        "communityInbound",
      Effect.fn("CommunityHttpApi.communityInbound")(function* (ctx) {
        // The verdict is deliberately dropped rather than returned — see `PeerAck`. It is not lost:
        // a stored message appears in the channel, and a rejected one is the door doing its job.
        yield* channels.deliver(ctx.payload.topic, ctx.payload.message)
        return { received: true } as const
      }),
    )
  }),
)
