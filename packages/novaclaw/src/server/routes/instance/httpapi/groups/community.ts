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
  Schema.Struct({ kind: Schema.Literal("off"), reason: Schema.Literals(["none", "airgap"]) }),
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
