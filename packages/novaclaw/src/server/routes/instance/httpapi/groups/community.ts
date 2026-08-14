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
   * Last-known addresses. Plural, and the reason a contact is not just a key: a bare public key is
   * unroutable, so an entry without routes is an identity we cannot reach.
   */
  routes: Schema.Array(Schema.String),
  lastSeenAt: Schema.optional(Schema.Number),
  blocked: Schema.Boolean,
  addedAt: Schema.Number,
})

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

const ContactParams = Schema.Struct({ networkID: Schema.String })
const BlockPayload = Schema.Struct({ blocked: Schema.Boolean })
const ChannelParams = Schema.Struct({ name: Schema.String })

export const CommunityPaths = {
  contacts: "/api/community/contact",
  contact: "/api/community/contact/:networkID",
  contactBlock: "/api/community/contact/:networkID/block",
  channels: "/api/community/channel",
  channelHistory: "/api/community/channel/:name/history",
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
      HttpApiEndpoint.get("channelList", CommunityPaths.channels, {
        success: described(Schema.Array(CommunityChannel), "Channels this instance has joined"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.list",
          summary: "List joined channels",
          description: "The channels this instance subscribes to.",
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
