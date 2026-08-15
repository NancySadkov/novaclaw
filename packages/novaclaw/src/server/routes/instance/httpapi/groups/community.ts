import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

/**
 * Community P3/P4 — the instance-hosted forum's read/write surface (`todo/community-p2p.md`).
 *
 * The stores exist in core and nothing could reach them; this is the layer the Community app needs,
 * and it is independent of which transport eventually carries the messages.
 *
 * ⚠️ Instance-global, not workspace-routed: contacts and channels belong to the INSTANCE, exactly
 * like its identity. A community that differed per open folder would be four communities.
 */

export const CommunityContact = Schema.Struct({
  /** `nid_…` — the public key, which is the identity. There is no separate id to drift from it. */
  networkID: Schema.String,
  petname: Schema.optional(Schema.String),
  /**
   * Keys this peer has rotated away from, newest first.
   *
   * 🔴 Declared here because attribution needs it: a message is signed by whatever key its author
   * held AT THE TIME, so history written before a rotation resolves to nobody without this — and an
   * undeclared field is silently dropped by the response schema, which looks exactly like a backend
   * that never sent it.
   */
  formerIDs: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Last-known addresses. Plural, and the reason a contact is not just a key: a bare public key is
   * unroutable, so an entry without routes is an identity we cannot reach.
   */
  routes: Schema.Array(Schema.String),
  lastSeenAt: Schema.optional(Schema.Number),
  blocked: Schema.Boolean,
  addedAt: Schema.Number,
})

/**
 * Whether anything can currently carry a message, and why not when it cannot.
 *
 * ⚠️ `off` carries a REASON because the two cases are different things to tell a person: "the part
 * that carries messages is still being built" versus "you switched the network off". A single
 * disconnected state would make an airgapped instance look broken.
 */
export const CommunityTransportState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("off"), reason: Schema.Literals(["airgap", "no-peers"]) }),
  Schema.Struct({ kind: Schema.Literal("connecting") }),
  Schema.Struct({ kind: Schema.Literal("online"), peers: Schema.Number }),
])

export const CommunityChannel = Schema.Struct({
  name: Schema.String,
  muted: Schema.Boolean,
})

export const CommunityMessageInfo = Schema.Struct({
  id: Schema.String,
  channel: Schema.String,
  author: Schema.String,
  /** The author's CLAIMED time — signed, and freely chosen by them. */
  at: Schema.Number,
  /** When THIS instance received it: the only time we can vouch for, and the sort key. */
  receivedAt: Schema.Number,
  body: Schema.String,
})

const AddContact = Schema.Struct({
  networkID: Schema.String,
  petname: Schema.optional(Schema.String),
  routes: Schema.optional(Schema.Array(Schema.String)),
})

/**
 * The result of saying something.
 *
 * ⚠️ `delivered` is NOT "was it read" — nobody can promise delivery in a network with no server. It
 * says only that a transport accepted it. False means the message is in the author's own log and has
 * no audience yet, which is every install until P2 lands.
 */
const PostResult = Schema.Struct({
  id: Schema.String,
  stored: Schema.Boolean,
  delivered: Schema.Boolean,
})

const ContactParams = Schema.Struct({ networkID: Schema.String })
const BlockPayload = Schema.Struct({ blocked: Schema.Boolean })
const ChannelParams = Schema.Struct({ name: Schema.String })

export const CommunityPaths = {
  contacts: "/api/community/contact",
  contact: "/api/community/contact/:networkID",
  contactBlock: "/api/community/contact/:networkID/block",
  transport: "/api/community/transport",
  channels: "/api/community/channel",
  channel: "/api/community/channel/:name",
  channelMute: "/api/community/channel/:name/mute",
  discover: "/api/community/discover",
  channelsArchived: "/api/community/channel/archived",
  channelHistory: "/api/community/channel/:name/history",
  channelPost: "/api/community/channel/:name/post",
} as const

export const CommunityApi = HttpApi.make("community").add(
  HttpApiGroup.make("community")
    .add(
      HttpApiEndpoint.get("contactList", CommunityPaths.contacts, {
        success: described(Schema.Array(CommunityContact), "Every known contact, blocked ones included"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.contact.list",
          summary: "List contacts",
          description:
            "The instance's address book. It doubles as the bootstrap set: any one live contact is a complete entry point to the network, which is why it needs no seed list from us.",
        }),
      ),
      HttpApiEndpoint.post("contactAdd", CommunityPaths.contacts, {
        payload: AddContact,
        success: described(CommunityContact, "The stored contact"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.contact.add",
          summary: "Add a contact",
          description:
            "Add a peer by its network identity. Rejected unless the id parses as a public key: a contact that cannot verify a signature is one that silently never will.",
        }),
      ),
      HttpApiEndpoint.delete("contactForget", CommunityPaths.contact, {
        params: ContactParams,
        success: described(Schema.Boolean, "True when a contact was removed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.contact.forget",
          summary: "Forget a contact",
          description: "Remove a peer from the address book. Does not delete anything they said.",
        }),
      ),
      HttpApiEndpoint.post("contactBlock", CommunityPaths.contactBlock, {
        params: ContactParams,
        payload: BlockPayload,
        success: described(Schema.Boolean, "True when the contact's blocked state changed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.contact.block",
          summary: "Block or unblock a contact",
          description:
            "With no moderator anywhere, blocking is the only power a user has over what they receive. Blocked authors are dropped as messages arrive, not hidden after being stored.",
        }),
      ),
      HttpApiEndpoint.get("transportState", CommunityPaths.transport, {
        success: described(CommunityTransportState, "Whether a transport can currently carry messages"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.transport.state",
          summary: "Transport state",
          description:
            "Report whether the community network can carry messages. `off` names its reason so the UI can distinguish a transport that does not exist yet from one airgap has switched off.",
        }),
      ),
      HttpApiEndpoint.get("channelList", CommunityPaths.channels, {
        success: described(Schema.Array(CommunityChannel), "Channels this instance has joined"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.list",
          summary: "List joined channels",
          description: "The channels this instance subscribes to.",
        }),
      ),
      HttpApiEndpoint.post("communityDiscover", CommunityPaths.discover, {
        payload: Schema.Struct({ addresses: Schema.optional(Schema.Array(Schema.String)) }),
        success: described(
          Schema.Struct({ learned: Schema.Number, asked: Schema.Number, peers: Schema.Number }),
          "How many peers were learned, and how many are now known",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.discover",
          summary: "Find other instances",
          description:
            "Runs every bootstrap source at once: instances advertising on this LAN, any addresses supplied, and peer exchange with everyone already reachable. Plurality is the point — if one source dies, the others still reach a live network, which is why no single seed list can switch this off. Addresses are enough: an instance tells us its own key, so nobody has to type one.",
        }),
      ),
      HttpApiEndpoint.get("channelArchived", CommunityPaths.channelsArchived, {
        success: described(
          Schema.Array(Schema.Struct({ name: Schema.String, messages: Schema.Number })),
          "Channels whose messages we hold but no longer subscribe to",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.archived",
          summary: "Channels you left but still have history for",
          description:
            "Leaving keeps a channel's messages. Without this the only way back to them is to retype the name exactly — a value the user has no way to know, for a room we are still holding on disk.",
        }),
      ),
      HttpApiEndpoint.post("channelJoin", CommunityPaths.channels, {
        payload: Schema.Struct({ name: Schema.String }),
        success: described(Schema.Array(CommunityChannel), "Channels after joining"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.join",
          summary: "Join a channel",
          description:
            "Subscribe to a channel by name. A name is only a hash — nobody owns one, and joining grants nothing but a topic to listen on.",
        }),
      ),
      HttpApiEndpoint.delete("channelLeave", CommunityPaths.channel, {
        params: ChannelParams,
        success: described(Schema.Boolean, "True when this instance was subscribed and now is not"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.leave",
          summary: "Leave a channel",
          description:
            "Stop subscribing. History SURVIVES: deleting it would make leaving a destructive act nobody asked for, and rejoining would show an empty room the user knows had messages in it.",
        }),
      ),
      HttpApiEndpoint.post("channelMute", CommunityPaths.channelMute, {
        params: ChannelParams,
        payload: Schema.Struct({ muted: Schema.Boolean }),
        success: described(Schema.Boolean, "True when the channel's muted state changed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.mute",
          summary: "Mute or unmute a channel",
          description:
            "Muting keeps the subscription and quiets the UI — distinct from leaving. With no moderator, a user's own attention is the only thing they control, and a channel worth keeping is not always a channel worth being interrupted by.",
        }),
      ),
      HttpApiEndpoint.post("channelPost", CommunityPaths.channelPost, {
        params: ChannelParams,
        payload: Schema.Struct({ body: Schema.String }),
        success: described(PostResult, "Whether the message was stored, and whether anything took it"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.post",
          summary: "Say something in a channel",
          description:
            "Sign a message as this instance, store it locally, then offer it to the transport. Storing happens FIRST, so a missing or offline transport costs an audience and never the message.",
        }),
      ),
      HttpApiEndpoint.get("channelHistory", CommunityPaths.channelHistory, {
        params: ChannelParams,
        success: described(Schema.Array(CommunityMessageInfo), "Stored messages, most recently RECEIVED first"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.history",
          summary: "Read a channel's history",
          description:
            "Gossip only reaches whoever is online, so this local log is what makes a channel readable by someone who was away. Ordered by receive time, never by the author's own claimed timestamp.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "community",
        description: "The instance-hosted P2P community: contacts, channels and their local history.",
      }),
    )
    .middleware(Authorization),
)

/**
 * Community P2 — the PEER-facing surface, and the one group here with **no `Authorization`**.
 *
 * 🔴 That is the design, not an oversight. A node that only accepts messages from callers holding
 * this instance's token is a private federation with extra steps; an open community means strangers
 * can hand us bytes. What protects it is not a credential but the ingress door those bytes must pass:
 * proof-of-work FIRST (0.83 µs to check, ~49 ms for them to produce), then signature, subscription,
 * block, size and duplicate rules — every one of them measured, and all of them in
 * `CommunityChannels.record`.
 *
 * ⚠️ Reachability is not granted by this route. An instance behind a NAT with no port forwarded is
 * not addressable from outside no matter what it serves, so this widens the surface exactly as far as
 * the instance was already exposed — LAN for a normal install, the internet for one the user chose to
 * publish.
 */
export const CommunityPeerPaths = {
  inbound: "/api/community/inbound",
  syncSummary: "/api/community/sync/summary",
  syncIds: "/api/community/sync/ids",
  syncMessages: "/api/community/sync/messages",
  peers: "/api/community/peers",
} as const

/** A `Proven` message on the wire. Shape only — every rule about it lives at the ingress door. */
const PeerMessage = Schema.Struct({
  channel: Schema.String,
  author: Schema.String,
  at: Schema.Number,
  body: Schema.String,
  signature: Schema.String,
  nonce: Schema.Number,
})

/**
 * ⚠️ Addressed by TOPIC. The receiver resolves it against the channels IT joined, so a hash it does
 * not recognise is unresolvable rather than merely unwanted — "we are not subscribed" holds by
 * arithmetic instead of by trusting the sender's channel name.
 */
const PeerDelivery = Schema.Struct({ topic: Schema.String, message: PeerMessage })

/**
 * 🔴 Deliberately UNIFORM: `received` is always true, and the verdict is never disclosed.
 *
 * Reporting `blocked` would tell a peer they are blocked; `not-subscribed` would let anyone map which
 * channels this instance is in by probing topics. Neither is information a stranger is owed, and both
 * are cheap to harvest at scale. This costs the sender nothing real — `delivered` has always meant
 * "a transport accepted it", never "it was stored", let alone "it was read".
 */
const PeerAck = Schema.Struct({ received: Schema.Literal(true) })

/**
 * Community P4 — the three steps of a catch-up, served to whoever asks.
 *
 * 🔴 Addressed by TOPIC throughout, and an unknown topic answers EMPTY rather than "no such channel".
 * The two are indistinguishable to the asker, which is the point: a peer must not be able to map
 * which rooms this instance is in by walking topic hashes, and reconciliation needs no such answer to
 * work — an empty summary simply means there is nothing here to catch up on.
 */
const SyncTopic = Schema.Struct({ topic: Schema.String })
const SyncSummary = Schema.Struct({ buckets: Schema.Array(Schema.String) })
const SyncIdsRequest = Schema.Struct({ topic: Schema.String, buckets: Schema.Array(Schema.Number) })
const SyncIds = Schema.Struct({ ids: Schema.Array(Schema.String) })
const SyncMessagesRequest = Schema.Struct({ topic: Schema.String, ids: Schema.Array(Schema.String) })
const SyncMessages = Schema.Struct({ messages: Schema.Array(PeerMessage) })

/**
 * 🔴 PEER EXCHANGE — the mechanism that makes the anti-shutdown claim literally true.
 *
 * The spec: *any peer address from any source is a complete entry point, because peer exchange
 * supplies the rest. There is no list to seize, because there is nothing special about any
 * particular entry.* Without this endpoint that sentence is false — one address stays one address,
 * and a network that needs OUR seed list is one we could switch off by deleting it.
 *
 * ⚠️ What it returns is ROUTES, never the user's address book. A blocked peer is excluded: blocking
 * is the only power a user has here, and an instance that still handed out a blocked peer's address
 * would be a distributor for someone its owner refuses to hear.
 */
const PeerList = Schema.Struct({
  peers: Schema.Array(Schema.Struct({ networkID: Schema.String, routes: Schema.Array(Schema.String) })),
})

export const CommunityPeerApi = HttpApi.make("communityPeer").add(
  HttpApiGroup.make("communityPeer")
    .add(
      HttpApiEndpoint.get("communityPeers", CommunityPeerPaths.peers, {
        success: described(PeerList, "Other instances this one believes are reachable"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.exchange",
          summary: "Ask for other peers",
          description:
            "Peer exchange: how one address becomes an entry point to the whole network. Returns routes this instance believes work, never the user's contact list, and never a blocked peer.",
        }),
      ),
      HttpApiEndpoint.post("communityInbound", CommunityPeerPaths.inbound, {
        payload: PeerDelivery,
        success: described(PeerAck, "Always true — the verdict is deliberately not disclosed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.inbound",
          summary: "Accept a community message from a peer",
          description:
            "The open door of the P2P network: any instance may hand this one a signed, work-proven message. Unauthenticated by design — a node that required a token would be a private federation, not a community. The answer is always the same so that probing reveals neither our subscriptions nor our block list.",
        }),
      ),
      HttpApiEndpoint.post("communitySyncSummary", CommunityPeerPaths.syncSummary, {
        payload: SyncTopic,
        success: described(SyncSummary, "One digest per bucket — ~4 KB whatever the log size"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.sync.summary",
          summary: "Summarise a channel for reconciliation",
          description:
            "Step 1 of catching up. Bucketed digests, so two instances that already agree exchange ~4 KB and stop, instead of the ~320 KB their full id lists would cost. An unknown topic answers empty.",
        }),
      ),
      HttpApiEndpoint.post("communitySyncIds", CommunityPeerPaths.syncIds, {
        payload: SyncIdsRequest,
        success: described(SyncIds, "The ids held in the named buckets"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.sync.ids",
          summary: "List message ids in specific buckets",
          description:
            "Step 2. Only buckets whose digests differ need their ids exchanged, so the cost tracks the DIFFERENCE rather than the size of either log.",
        }),
      ),
      HttpApiEndpoint.post("communitySyncMessages", CommunityPeerPaths.syncMessages, {
        payload: SyncMessagesRequest,
        success: described(SyncMessages, "The requested messages this instance holds"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.sync.messages",
          summary: "Fetch messages by id",
          description:
            "Step 3. The asker decides what it wants, and everything it receives still passes its own ingress door — a peer that answers a sync earns no more trust than a stranger pushing a message.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "community-peer",
        description: "Peer-to-peer ingress. Open to strangers on purpose; guarded by proof-of-work and signatures.",
      }),
    ),
)
