import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { Database } from "@novaclaw/core/database/database"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { Scratch } from "@novaclaw/core/scratch"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { MDNS } from "@/server/mdns"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunityDht } from "@novaclaw/core/community/dht"
import { CommunitySeeds } from "@novaclaw/core/community/seeds"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { CommunityTopic } from "@novaclaw/core/community/topic"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { LLM, LLMClient, LLMEvent, Message, SystemPart } from "@novaclaw/llm"
import { ReasoningBudget } from "@novaclaw/core/session/runner/reasoning-budget"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { llmClient } from "@novaclaw/core/effect/app-node-platform"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Log } from "@novaclaw/schema/log"
import { EffectBridge } from "@/effect/bridge"
import { Duration, Effect, Option, Semaphore, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

/**
 * Community P3/P4 — the forum's HTTP surface (`notes/spec/community-p2p.md`).
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
    // NC-REL-026: the rotation and its successor statement must commit together — see the handler.
    const { db } = yield* Database.Service
    const search = yield* CommunitySearch.Service
    const direct = yield* CommunityDirect.Service
    const offers = yield* CommunityOffer.Service
    const peersStore = yield* CommunityPeers.Service
    const transport = yield* CommunityTransport.Service
    const dht = yield* CommunityDht.Service
    const bridge = yield* EffectBridge.make()
    const posts = yield* CommunityPost.Service
    // Rotation writes its own statement here before announcing it — see `communityRotate`.
    const successions = yield* CommunitySuccession.Store

    return (
      handlers
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
                /**
                 * ⚠️ Forwarded, and it was NOT. Declaring `trust` on the payload schema made it
                 * arrive and made it typecheck; this line is what makes it do anything. The POST
                 * answered 200 with the old rating intact — a success that changed nothing, which is
                 * the mirror of a field dropped on the way OUT and just as quiet.
                 */
                ...(ctx.payload.trust === undefined ? {} : { trust: ctx.payload.trust }),
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
            /**
             * 🔴 KEPT before it is announced (review 2026-08-17) — and now kept ATOMICALLY with the
             * rotation itself (NC-REL-026).
             *
             * The statement used to exist only for the length of the announce round: peers that were
             * offline could ask us for successions afterwards and get everyone's but OURS, so the one
             * rotation this instance is the authority on was the one it could not answer for. A
             * statement's whole purpose is that somebody who was away can still find their way to the
             * current key — and ours is the only one we can never re-learn from anybody else.
             *
             * ⚠️ The two writes were SEQUENTIAL and in separate stores: `rotate()` replaced the sole
             * identity row with the new keypair, and only then did `remember` persist the bridge. A
             * failure in between left the instance holding a key nobody can connect to the one its
             * peers trust — unrecoverable, because the predecessor secret is gone and it is the only
             * thing that could sign a replacement statement.
             *
             * ⚠️ Reordering would not fix it, which is why this is a transaction. A statement written
             * before a swap that then failed points peers at a key this instance does not hold — the
             * same stranding from the other side. Only "both or neither" is safe.
             *
             * ⚠️ The stores need no `tx` handle: they close over the same drizzle handle on a single
             * guarded connection, and `db.transaction` installs the transaction in the FIBER context
             * for the duration of its body (`config-store-write.ts` documents this). Two constraints
             * follow — no forked fibers inside, and the network announce stays OUTSIDE, below.
             */
            const rotated = yield* db
              .transaction(
                () =>
                  Effect.gen(function* () {
                    const result = yield* identity.rotate()
                    yield* successions.remember(result.statement)
                    return result
                  }),
                // ⚠️ `orDie` on the TRANSACTION, not on the statements inside it — the convention
                // `config-store-write.ts` states: a defect from a store's own `orDie` still rolls back,
                // and a rotation that cannot commit is a fault, not a request error.
              )
              .pipe(Effect.orDie)
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
             * 🔴 **THE GATE, before any source opens a socket** (Codex review P2).
             *
             * `MDNS.browse()` opens an mDNS browser and the seed lookup calls the system TXT
             * resolver, and both ran unconditionally — only the DHT branch below asked. So a direct
             * call to this endpoint emitted LAN multicast and a DNS query after the user had switched
             * Community off or sealed the machine in airgap. The panel hides the button in those
             * states, which lowers the incidence and is not enforcement; principle 4's "nothing goes
             * in or out" is not a statement about which buttons are visible.
             *
             * ⚠️ Named, not silent. Zeroes would read as "the network is empty", and that is fixed by
             * pasting an address while this is fixed by turning the feature on — sending someone to
             * the wrong repair is the failure mode `refusals` returning an ARRAY exists to prevent.
             *
             * ⚠️ Resolved ONCE here rather than per source: three sources each asking the live gate is
             * three chances for the next source to be added without asking, which is exactly how the
             * DHT ended up the only guarded one.
             */
            const refusals = CommunityConsent.refusals(CommunityConsent.currentGate())
            if (refusals.length > 0)
              return {
                learned: 0,
                asked: 0,
                peers: (yield* peersStore.list()).length,
                seedsAsked: false,
                seedsFound: 0,
                refused: refusals,
              }

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
              | { community?: { seeds?: { enabled?: boolean; host?: string }; announce?: string } }
              | undefined
            const seedHost = stored?.community?.seeds?.host ?? CommunitySeeds.DEFAULT_SEED_HOST
            const seeds = yield* CommunitySeeds.resolve({
              ...(stored?.community?.seeds === undefined ? {} : { settings: stored.community.seeds }),
            })

            /**
             * 🔴 The public DHT — the automatic door for somebody who knows nobody and is not on a
             * LAN with anyone.
             *
             * ⚠️ Silent and lazy: the sidecar is a Rust binary the app builds without, so a machine
             * that never compiled it simply finds no peers here. That must cost nothing, which is why
             * every failure in `find` answers `[]` rather than raising.
             *
             * 🔴 And we announce ONLY what the user typed. Publishing an address to a public
             * directory is a decision above joining and above answering: it is read by people who
             * never talk to us, and an instance cannot know its own external address — it sees
             * interfaces, and a NAT'd machine sees private ones. Absent is the ordinary state and
             * costs nothing, because an unreachable instance dials OUT and never needed to be found.
             */
            const announce = stored?.community?.announce
            /**
             * 🔴 DETACHED, because a DHT lookup costs about TEN SECONDS and this is a button.
             *
             * Measured 2026-08-17: with the sidecar present, `discover` took longer than five seconds
             * and a server test timed out on it. A cold Kademlia node has to fill a routing table
             * (~2 s) before a query can walk anywhere (~8 s), and no budget fixes that — a shorter one
             * just guarantees it finds nobody. `AGENTS.md` is explicit that *the DHT is a convenience,
             * and a convenience that slows the guarantees down is not one*: the LAN, peer exchange and
             * a typed address are the guarantees, and they must not queue behind it.
             *
             * ⚠️ So the lookup runs in the background and its peers land in the table for the NEXT
             * discovery. Nothing is lost: the node is long-lived now, so the second lookup is warm, and
             * `learnFrom` is idempotent — it asks each address who lives there before recording anything.
             *
             * ⚠️ `bridge.fork` rather than `Effect.fork`: a child of the REQUEST's scope is
             * interrupted the moment the response is written, which for a ten-second lookup means it
             * never finishes once.
             */
            // ⚠️ No gate check here any more: the ONE resolved above already refused every path.
            bridge.fork(
              Effect.gen(function* () {
                const viaDht = yield* dht.find(announce === undefined ? {} : { announce })
                if (viaDht.length > 0) yield* sync.learnFrom(viaDht, "dht")
                /**
                 * 🔴 The ONE signal that this ran. Everything inside is silent by design — no
                 * binary, no peers and a crashed sidecar all mean "nothing found" — and detaching it
                 * removed the last way to tell that from a fiber that never executed.
                 *
                 * ⚠️ The COUNT only. Which peers came back is a set of strangers' network
                 * locations, and a log is the wrong place to keep those.
                 */
                yield* Log.event("community.dht.searched", { "community.peers": viaDht.length })
              }).pipe(
                // Silent to the CALLER by design, like every other DHT failure: no peers is the
                // ordinary answer, and a discovery must never fail a join.
                Effect.catchCause(() => Effect.void),
              ),
            )

            yield* sync.learnFrom(lan, "lan")
            yield* sync.learnFrom(seeds, "dns")
            yield* sync.learnFrom(supplied, "manual")
            const exchange = yield* sync.discover()

            /**
             * 🔴 **PULL successions too, because the push is not enough** (found by re-running the
             * two-instance journey after this session's changes, 2026-08-18).
             *
             * A rotation propagates by `sync.successions(statement)` at the moment it happens, to
             * whoever is reachable right then — so anyone offline at that instant, met afterwards, or
             * BLOCKED by the rotating instance never learns, and goes on attributing that peer's
             * history to a key they abandoned. The journey caught it once blocking and rotation were
             * exercised in the same run: B blocked A, rotated, and correctly told nobody; A had no way
             * to find out.
             *
             * ⚠️ Withholding the PUSH from a blocked peer is right and stays — publishing to somebody
             * whose messages you refuse tells them you are online. Pulling is the other side of that:
             * `GET /succession` is an anonymous door by design, precisely because a statement is
             * self-verifying and about the sender's OWN key, so refusing to serve it would only leave
             * the reader misattributing old messages.
             *
             * ⚠️ No announce argument: this pulls and never pushes. Discovery must not become a second
             * place that broadcasts our own rotation.
             */
            yield* sync.successions(undefined)
            return {
              learned: exchange.learned,
              asked: exchange.asked,
              peers: (yield* peersStore.list()).length,
              // Declared alongside, in the same edit — a field returned but undeclared is dropped.
              /**
               * 🔴 Whether a zone was ACTUALLY asked, not whether asking is switched on (review 1.16).
               *
               * This read `enabled !== false`, which is true on a default install — where there is no
               * host to ask, because `DEFAULT_SEED_HOST` is `undefined` and the project runs no zone.
               * So the panel said starting addresses were tried when nothing had been, and offered the
               * user a repair for a door that does not exist.
               */
              seedsAsked: stored?.community?.seeds?.enabled !== false && seedHost !== undefined,
              seedsFound: seeds.length,
            }
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
            /**
             * ⚠️ Read from the STORED config, which is where the user's answer lives. Declaring the
             * field without this line is the failure that has happened twice here already: a 200 that
             * shows nothing, indistinguishable from never having set it.
             */
            const published = (CommunityConsent.storedConfig() as { community?: { announce?: string } } | undefined)
              ?.community?.announce
            // ⚠️ Compared against the address the DHT was actually given: a user who edited the setting
            // since the last attempt must not see the OLD address's verdict attached to the new one.
            const announcedState = yield* dht.announced()
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
              ...(published === undefined || published === "" ? {} : { announce: published }),
              /**
               * ⚠️ Declared AND forwarded in the same edit. This field has been lost in each
               * direction separately before, and for a claim about whether strangers can find you, a
               * silently dropped value is worse than an absent one.
               */
              ...(announcedState === undefined || announcedState.address !== published
                ? {}
                : {
                    announceConfirmed: announcedState.published,
                    ...(announcedState.reason === undefined ? {} : { announceReason: announcedState.reason }),
                  }),
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
                  message:
                    "An offer's endpoint must be an http:// or https:// URL — that is what peers will connect to.",
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
    const locations = yield* LocationServiceMap.Service
    /**
     * How long one answering turn may run before it is abandoned.
     *
     * ⚠️ **Not a substitute for the token budget, which already does the harder half.**
     * `ReasoningBudget` counts reasoning live, nudges the model as it runs down, and MECHANICALLY forces
     * an answer when it is gone — the same machinery the title pass uses to generate with almost none.
     * That bounds the MODEL. What it cannot bound is a provider that stalls mid-stream or a socket that
     * never closes, and no token ceiling ever will.
     *
     * 🔴 The same comment that put a 30-second cap on resolving the model — *"a stuck resolve would
     * hold a stranger's connection open indefinitely"* — applies with more force to the stream, and was
     * not applied there.
     *
     * 🔴 Two costs, and the second is the one that matters: a slow turn holds the ONE permit, so every
     * other peer is told `busy` for as long as it runs. A single hung provider takes this instance out of
     * the network for everybody.
     *
     * ⚠️ Set BELOW the asker's own `ANSWER_TIMEOUT_MS` (60 s), so we stop working before they stop
     * waiting. Generating past that point spends the user's tokens on an answer that cannot be delivered
     * — and now that the spend is counted when the model STARTS, it spends their daily budget too.
     */
    const ANSWERING_TURN_MS = 45_000

    /** Distinguishes "the turn ran out of time" from "the model was never reachable", which read the same before. */
    const TURN_TIMED_OUT = { timedOut: true } as const

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
          /**
           * 🔴 SIGNED, and the verdict is still not disclosed (Codex review P1). The ack proves the
           * holder of this key received a message with this id — equally true whether it was stored,
           * refused as blocked, or dropped as unreadable — so the uniform reply keeps its property
           * while a black hole loses the one it was exploiting: an endpoint claiming somebody else's
           * key cannot produce this, and `sendDirect` stops reporting success for a message nobody
           * will ever read.
           *
           * ⚠️ Signed for a blocked sender too, for the same reason the reply is uniform.
           */
          const at = Date.now()
          const unsigned = {
            recipient: (yield* selfIdentity.identity()).networkID,
            sender: ctx.payload.from,
            message: CommunityDirect.messageID(ctx.payload),
            at,
          }
          const signature = yield* selfIdentity.sign(CommunityDirect.deliveryBytes(unsigned))
          return {
            received: true,
            by: unsigned.recipient,
            at,
            signature: signature.toString("base64url"),
          } as const
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
          /**
           * 🔴 Every refusal leaves here SIGNED (Codex review P1). The asker records a first-hand
           * dealing about us on a refusal — *"they would not answer"* is what standing is made of —
           * so an unsigned one let any endpoint answering at an address write a dealing in a
           * victim's name. Bound to the ask's own signature so it cannot be replayed at the next
           * question.
           *
           * ⚠️ Signed for a BLOCKED asker too. Withholding the proof there would make a block
           * distinguishable from a quiet day, which is the property the uniform refusal exists for.
           */
          const refuse = (reason: CommunityAnswer.WireRefusal) =>
            Effect.gen(function* () {
              const at = Date.now()
              const unsigned = {
                author: (yield* selfIdentity.identity()).networkID,
                asker: typeof ctx.payload.asker === "string" ? ctx.payload.asker : "",
                request: typeof ctx.payload.signature === "string" ? ctx.payload.signature : "",
                reason,
                at,
              }
              const signature = yield* selfIdentity.sign(CommunityAnswer.refusalBytes(unsigned))
              return {
                refused: reason,
                refusalAt: at,
                refusalSignature: signature.toString("base64url"),
              } as const
            })

          const overall = yield* answers.state()
          if (overall.refusal !== undefined) return yield* refuse(overall.refusal)

          /**
           * 🔴 **The question's WEIGHT, before a model is resolved and before a signature is
           * checked** (Codex review P1). `maxTokens` bounds what a model generates and says nothing
           * about prefill, so one signed ask could hand the owner a quarter-megabyte of input —
           * roughly 5 MB a day across the default budget — for the price of one signature.
           *
           * ⚠️ Cheapest-first, like the checks around it: measuring a string costs nothing, so it
           * happens before the 41 µs signature verification rather than after. A question too large
           * to answer is too large whoever signed it.
           *
           * ⚠️ `not-answering`, not a new wire token that would tell a prober exactly which ceiling
           * they hit and therefore what to vary — the same reason the block refusal is
           * indistinguishable from a quiet day.
           */
          if (CommunityAnswer.questionTooLarge(ctx.payload.question)) return yield* refuse("not-answering")

          /**
           * ⚠️ Verified against OUR OWN identity, because the signature now names who the question is
           * for. An ask addressed to another instance does not verify here, so a captured question
           * cannot be replayed across the network to burn its author's share — and, since answering
           * became trust-aware, their standing — at every instance that receives it.
           */
          const me = (yield* selfIdentity.identity()).networkID
          if (!CommunityAnswer.verifyAsk(ctx.payload, me)) return yield* refuse("unsigned")

          /**
           * 🔴 BLOCKING applies here too — the checklist's inbound rule 4, *"check blocking if the
           * operation attributes anything to an author, and check it at INGRESS"*, and the exact
           * mirror of the outbound gap found a day earlier. A blocked peer could not reach this user
           * in a room or by direct message, and could still make them SPEND TOKENS answering it.
           *
           * The consent screen tells people *"you can block people, and that is the only power anyone
           * has here"*, which was not true of the one door that costs the user money.
           *
           * ⚠️ Refused as `not-answering`, deliberately indistinguishable from an instance that
           * simply is not answering today — the DM door drops its verdict for the same reason, so a
           * stranger cannot learn they were singled out.
           *
           * ⚠️ Before `allowed`, so a blocked asker does not move this user's budget accounting at
           * all, and after `verifyAsk`, because a refusal keyed on WHO is asking is worthless against
           * an identity nobody proved.
           */
          const asking = yield* contacts.get(ctx.payload.asker)
          if (asking?.blocked === true) return yield* refuse("not-answering")

          const refusal = yield* answers.allowed(ctx.payload.asker)
          if (refusal !== undefined) return yield* refuse(refusal)

          /**
           * 🔴 The evidence packet, gathered BEFORE the permit is taken.
           *
           * ⚠️ Outside the semaphore deliberately: this is database work, and holding the one
           * answering permit while doing it would let a question that never reaches a model block
           * the peer who asked next. The permit is for the MODEL, which is the scarce thing.
           *
           * ⚠️ Joined rooms only, and each is read as a bounded page. Every message here is one the
           * peer surface hands to any stranger through `/sync/messages`, which is what makes
           * answering from them a saving of a round trip rather than a disclosure.
           */
          /**
           * 🔴 EVERY key this user has held, not the one they hold now.
           *
           * A room message records its author by the key that signed it. Comparing against the
           * current key alone therefore made a rotation retroactively disown this user's own posts:
           * they came back as `HEARD from <our own former key>`, and the system prompt tells the
           * model the evidence says which of SAW and HEARD applies. `heldKeys` walks the succession
           * chain BACKWARD from the key we hold, which is a walk every step of which is signed by a
           * key we hold or held — see its own note on why the forward direction is not safe here.
           */
          const mine = InstanceIdentityStore.heldKeys(
            (yield* selfIdentity.identity()).networkID,
            yield* successions.known(),
          )
          const rooms = yield* channels.channels()
          const claims: CommunityAnswer.Evidence[] = []
          for (const room of rooms.slice(0, CommunityAnswer.MAX_EVIDENCE_ROOMS))
            for (const message of yield* channels.history(room.name, CommunityAnswer.MAX_EVIDENCE_SCANNED))
              // `witness` is the only constructor of a piece of evidence: it takes the key SET, so
              // "was this us" cannot be answered against a single key at a call site again.
              claims.push(CommunityAnswer.witness(message, mine))
          const evidence = CommunityAnswer.selectEvidence(ctx.payload.question, claims)

          const answer = yield* turn.withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              const models = yield* SessionRunnerModel.Service
              const llm = yield* LLMClient.Service
              // ⚠️ BOUNDED, for the reason the memory handler records: resolving does not call the
              // model, so it is fast or it is stuck, and a stuck resolve here would hold a stranger's
              // connection open indefinitely.
              const model = yield* models.resolveDefault().pipe(
                Effect.timeoutOrElse({
                  duration: "30 seconds",
                  orElse: () => Effect.die("resolveDefault timed out"),
                }),
              )
              /**
               * 🔴 From here on the model RUNS, and that is what the budget must count.
               *
               * The spend used to be recorded only once an answer existed, so that a failed turn
               * "does not consume the day". The half of that reasoning which was wrong: an EMPTY
               * completion is a turn that ran and cost real tokens — and a reasoning model on a
               * tight thinking budget returns exactly that, as this program measured (18 of 24 at
               * 300 tokens). A stranger able to induce one could spend the user's tokens without
               * ever moving a counter, which is a bound enforced on our side of the wire and not on
               * theirs.
               */
              yield* answers.spent(ctx.payload.asker)
              const chunks: string[] = []
              /**
               * 🔴 The THINKING is bounded, not just the total — the mechanism the title pass
               * already uses (owner, 2026-08-17).
               *
               * Raising `maxTokens` alone only bought a reasoning model more room to think itself
               * out of answering: it spent the budget and returned an empty completion, and the
               * asker was told "no-answer" as though we had nothing to say. `ReasoningBudget`
               * counts reasoning tokens live, nudges as they run down, and has a MECHANICAL hard
               * stop that re-issues the turn with thinking structurally disabled. That is the
               * difference between hoping a model stops thinking and making it.
               *
               * ⚠️ `maintenance.ts` records the pairing hazard beside its own use: reasoning-
               * budget argues its safety from phases inheriting an UNSET max_tokens, and an
               * explicit ceiling weakens that argument, so the two numbers must be re-checked
               * together if either moves. Here the ceiling is the user's knob, which is exactly the
               * thing that can move — so the budget is deliberately a small fraction of it.
               */
              yield* ReasoningBudget.stream({
                request: LLM.request({
                  model,
                  system: [SystemPart.make(CommunityAnswer.SYSTEM)],
                  // 🔴 FRAMED. The question is a stranger's words entering a model's context, and
                  // this one is more dangerous than a channel body because the model is SUPPOSED
                  // to act on it.
                  /**
                   * 🔴 EVIDENCE, then the question (Codex review P2).
                   *
                   * The turn used to carry the system prompt and the question alone, so "what
                   * this instance knows" was the base model's pretrained weights — and the
                   * motivating flow of the whole feature is one Nova asking another what
                   * happened TODAY. Without this the instance signs a year-old guess with its
                   * user's identity and spends their standing on it.
                   *
                   * ⚠️ Assembled ABOVE, outside the model call, from messages the peer surface
                   * already serves to any stranger who asks — so it discloses nothing a peer
                   * could not fetch directly.
                   */
                  messages: [
                    Message.user(CommunityAnswer.evidencePacket(evidence)),
                    Message.user(CommunityAnswer.framedQuestion(ctx.payload.question)),
                  ],
                  // 🔴 NO TOOLS. An instance that answers strangers with a full agent is a remote
                  // shell with extra steps; what it may use is what it would say aloud in a room.
                  tools: [],
                  // The user's ceiling: too small returns silence from a reasoning model.
                  generation: { maxTokens: overall.gate.maxTokens },
                }),
                stream: (next) => llm.stream(next),
                // A quarter of the answer's ceiling: enough to think, never enough to think INSTEAD
                // of answering, and it scales with the knob rather than drifting away from it.
                budget: Math.max(64, Math.floor(overall.gate.maxTokens / 4)),
              }).pipe(
                Stream.runForEach((event) => {
                  if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
                  return Effect.void
                }),
              )
              return chunks.join("") as string | undefined | typeof TURN_TIMED_OUT
            }).pipe(
              /**
               * 🔴 BOTH contexts, and the asymmetry is why the happy path never ran.
               *
               * `LLMClient` is a GLOBAL node and needs `AppNodeBuilder`; `SessionRunnerModel` is a
               * LOCATION service and needs a location. Providing only the first failed with
               * "Service not found: SessionRunnerModel" — and since that failure is caught and
               * turned into a named refusal, answering reported "unavailable" forever while looking
               * like a model problem. The memory handler records the mirror of this trap one file
               * over: a location context alone does not satisfy the global client.
               *
               * ⚠️ The app-managed SCRATCH directory, because answering a stranger belongs to no
               * project. The turn reads nothing from the location — it has no tools and no files —
               * it is needed only to resolve which model this instance would use.
               *
               * 🔴 This used to be `process.cwd()`, and that is the user's HOME on a desktop
               * launch (review §2, unit 6 F6): resolving a location boots a full location graph
               * including a RECURSIVE file watcher, so a stranger's question started a recursive
               * watch over everything the user owns. Principle 11 says the filesystem outside our
               * three places is read-only to us; a watcher is not a write, but walking a
               * stranger's whole home to answer a question they did not ask about it is the same
               * disregard for whose disk this is — and it is a cost no budget in this subsystem
               * could see.
               *
               * ⚠️ `Scratch.root()` rather than `ensure()`: resolving a model must not depend on
               * creating a directory, and the location graph does not require the path to exist.
               * The scratch root is provisioned on the `/path` route every client calls at boot.
               */
              Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(Scratch.root()) }))),
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
              /**
               * 🔴 The refusal is named to the ASKER; the CAUSE is named to the owner.
               *
               * Swallowing it entirely was the same mistake as the 500 in the other direction: a
               * stranger should not be told why our model is unhappy, and the person running the
               * instance has nothing else to look at. "unavailable" with no log is a feature that
               * cannot be diagnosed by anybody.
               */
              Effect.catchCause((cause) =>
                Log.event("community.answer.failed", { "community.cause": Log.fault(cause) }).pipe(
                  Effect.as(undefined),
                ),
              ),
              /**
               * 🔴 The whole TURN is bounded, not just the resolve. `ReasoningBudget` counts
               * tokens; a model that streams slowly, or a provider that stalls mid-response, is
               * bounded by neither — and it holds the ONE permit while it does, so every other peer
               * is told `busy` until it finishes. One hung provider takes this instance out of the
               * network for everybody.
               *
               * ⚠️ INSIDE the permit, so the release happens with it. Timing out around the
               * semaphore would answer the caller and leave the work running behind the lock.
               */
              Effect.timeoutOrElse({
                duration: Duration.millis(ANSWERING_TURN_MS),
                orElse: () => Effect.succeed<string | undefined | typeof TURN_TIMED_OUT>(TURN_TIMED_OUT),
              }),
            ),
          )

          // Nobody got the permit: somebody else's question is being answered right now.
          if (Option.isNone(answer)) return yield* refuse("busy")
          /**
           * ⚠️ A turn that ran out of TIME is named, like every other refusal here. The asker is
           * about to give up anyway; what this protects is the permit, and the owner's tokens.
           */
          // ⚠️ Discriminated by TYPE, not by identity: TypeScript does not narrow an object
          // comparison, and an unnarrowed union here would hide the empty-answer check below it.
          if (answer.value !== undefined && typeof answer.value !== "string") return yield* refuse("unavailable")
          // ⚠️ Distinct from "no-answer": the model never ran, rather than running and saying nothing.
          if (answer.value === undefined) return yield* refuse("unavailable")
          const text = answer.value.trim()
          // An empty completion is a broken call, not an answer worth signing our name to.
          if (text === "") return yield* refuse("no-answer")

          /**
           * ⚠️ The spend is already recorded — it happens the moment the model starts, not here.
           * What survives from the original reasoning is the part that was right: a turn that never
           * RAN must not consume the day, which is why `busy` and `unavailable` still cost nothing.
           * A turn that ran and said nothing has already spent the tokens, so it counts.
           */
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
            outcome: CommunityObservation.Outcome.ANSWERED,
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
          /**
           * 🔴 Bounded (Codex P1). This served the WHOLE table — up to 1,000 statements, ≈230 KB for
           * an ~80-byte GET, about 2,900× — and that table is fillable by anyone with a keypair,
           * since announcing a rotation costs no proof-of-work by design.
           *
           * ⚠️ The number is the one the ASKER already uses (`MAX_SUCCESSIONS_PER_ANSWER`), which is
           * the point: every honest caller has been discarding everything past 64 since the day it
           * was written, so serving more was pure amplification with no reader.
           */
          const statements = yield* successions.known()
          return { statements: statements.slice(0, CommunitySync.MAX_SUCCESSIONS_PER_ANSWER) }
        }),
      )
      .handle(
        "communityIdentity",
        Effect.fn("CommunityHttpApi.communityIdentity")(function* (ctx) {
          const self = yield* selfIdentity.identity()
          // Minted on first request and kept, so one fetch teaches a peer both halves of who lives
          // here — the identity to verify against, and the key to seal to.
          const sealing = yield* selfIdentity.sealingKey()
          /**
           * 🔴 The one part of this answer that is not a quotation (Codex P1).
           *
           * ⚠️ Signed only over a well-formed challenge, and `identityProofBytes` is what decides
           * that: it refuses anything that is not exactly 32 bytes, so this endpoint can never be
           * turned into a signing oracle for bytes of an attacker's choosing or length.
           */
          const bytes =
            ctx.query.challenge === undefined
              ? undefined
              : InstanceIdentityStore.identityProofBytes(ctx.query.challenge)
          const proof = bytes === undefined ? undefined : yield* selfIdentity.sign(bytes)
          return {
            networkID: self.networkID,
            sealingKey: sealing.publicKey,
            sealingSignature: sealing.signature,
            ...(proof === undefined ? {} : { proof: proof.toString("base64url") }),
          }
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
          /**
           * 🔴 Bounded on BOTH sides of the exchange (Codex P1). The caller's bucket list is
           * attacker-chosen and was walked whole; the answer was every id in those buckets — ~335 KB
           * for a ~200-byte request, from a door with no proof-of-work.
           *
           * ⚠️ Truncation is safe here and nowhere else in this protocol: the digests still differ
           * after a partial answer, so the next round asks for the rest. Reconciliation converges
           * more slowly; it does not lose anything.
           */
          return { ids: CommunityReconcile.answerIds(yield* channels.ids(room), ctx.payload.buckets) }
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
