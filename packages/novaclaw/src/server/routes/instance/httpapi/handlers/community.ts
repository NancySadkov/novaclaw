import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { MDNS } from "@/server/mdns"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { CommunityTopic } from "@novaclaw/core/community/topic"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { Effect } from "effect"
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
          yield* sync.learnFrom(lan, "lan")
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
        "channelsNearby",
        Effect.fn("CommunityHttpApi.channelsNearby")(function* () {
          return yield* sync.channelsNearby()
        }),
      )
      .handle(
        "offerPublish",
        Effect.fn("CommunityHttpApi.offerPublish")(function* (ctx) {
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
          return yield* channels.history(ctx.params.name)
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
