import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { PeerDoor } from "../middleware/peer-door"
import { described } from "./metadata"

/**
 * Community P3/P4 — the instance-hosted forum's read/write surface (`notes/spec/community-p2p.md`).
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
   * 🔴 The user's own trust rating, 1..5, absent when they never gave one.
   *
   * ⚠️ Declared here because it was NOT, and the symptom was perfect: the doorman flow stored a
   * rating, the API answered a contact with no `trust`, and the screen showed nothing — identical
   * to the value never having been written. The comment two fields down already warned that an
   * undeclared field is dropped silently and looks exactly like a stale backend. Found by driving
   * the real UI, not by any test.
   */
  trust: Schema.optional(Schema.Finite),
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
  lastSeenAt: Schema.optional(Schema.Finite),
  blocked: Schema.Boolean,
  addedAt: Schema.Finite,
})

/**
 * Whether anything can currently carry a message, and why not when it cannot.
 *
 * ⚠️ `off` carries a REASON because the three cases are different things to tell a person: "you have
 * not joined yet", "you switched the network off", and "nobody to dial". A single disconnected state
 * would make an airgapped instance look broken and a joinable one look dead.
 */
export const CommunityTransportState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("off"), reason: Schema.Literals(["airgap", "no-peers", "not-joined"]) }),
  Schema.Struct({ kind: Schema.Literal("connecting") }),
  Schema.Struct({ kind: Schema.Literal("online"), peers: Schema.Finite }),
])

/**
 * A signed service offer. ⚠️ `price` is FREE TEXT the offerer wrote — not an enum (which would be a
 * payment protocol with no rails) and not a number (which would look like a price this software can
 * enforce; it cannot, and settlement happens between two people elsewhere).
 */
const PeerOffer = Schema.Struct({
  kind: Schema.String,
  endpoint: Schema.String,
  models: Schema.Array(Schema.String),
  price: Schema.String,
  /** A Lightning address or LNURL, or empty. Displayed and copied — never paid by this software. */
  payTo: Schema.String,
  from: Schema.String,
  at: Schema.Finite,
  signature: Schema.String,
})

export const CommunityChannel = Schema.Struct({
  name: Schema.String,
  muted: Schema.Boolean,
  /**
   * ⚠️ Declared, because an undeclared field is silently DROPPED by the response schema and looks
   * exactly like a backend that never sent it. Caught live: the store returned `listed`, the wire did
   * not, and the toggle would have read as permanently off with nothing in the logs to say why.
   */
  listed: Schema.Boolean,
})

export const CommunityMessageInfo = Schema.Struct({
  id: Schema.String,
  channel: Schema.String,
  author: Schema.String,
  /** The author's CLAIMED time — signed, and freely chosen by them. */
  at: Schema.Finite,
  /** When THIS instance received it: the only time we can vouch for, and the sort key. */
  receivedAt: Schema.Finite,
  body: Schema.String,
})

const AddContact = Schema.Struct({
  networkID: Schema.String,
  petname: Schema.optional(Schema.String),
  routes: Schema.optional(Schema.Array(Schema.String)),
  /** The user's own rating, when they are adding somebody they already decided to trust. */
  trust: Schema.optional(Schema.Finite),
})

/**
 * The result of saying something.
 *
 * ⚠️ `delivered` is NOT "was it read" — nobody can promise delivery in a network with no server. It
 * says only that a transport accepted it. False means the message is in the author's own log and had
 * no audience at that moment: nobody reachable was in the room. It goes out to whoever asks for the
 * room's history later, which is what reconciliation is for.
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
  /** Whether this instance has joined the community, and if not, every reason why. */
  participation: "/api/community/participation",
  channels: "/api/community/channel",
  channel: "/api/community/channel/:name",
  channelMute: "/api/community/channel/:name/mute",
  channelListed: "/api/community/channel/:name/listed",
  channelsNearby: "/api/community/nearby",
  filters: "/api/community/filter",
  searchChannels: "/api/community/search-channels",
  directSend: "/api/community/direct/:networkID",
  directHistory: "/api/community/direct/:networkID/history",
  directList: "/api/community/direct",
  offerMine: "/api/community/offer/mine",
  offersKnown: "/api/community/offers",
  discover: "/api/community/discover",
  rotate: "/api/community/rotate",
  channelsArchived: "/api/community/channel/archived",
  channelHistory: "/api/community/channel/:name/history",
  channelPost: "/api/community/channel/:name/post",
  channelSync: "/api/community/channel/:name/sync",
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
            "Report whether the community network can carry messages. `off` carries a reason, and the three are genuinely different situations a caller must not merge: `not-joined` (this instance has never accepted what joining costs, so it does not reach out at all), `airgap` (its owner switched the network off), and `no-peers` (willing and able, but it knows nobody to dial — the one a user can fix in a minute).",
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
      HttpApiEndpoint.post("communityRotate", CommunityPaths.rotate, {
        success: described(
          Schema.Struct({ networkID: Schema.String, told: Schema.Finite }),
          "The new identity, and how many peers were told",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.rotate",
          summary: "Move to a new key, and tell everyone",
          description:
            "Issues a new identity plus a successor statement signed by the OLD key, then tells every reachable peer and collects the rotations they know. Contacts follow the statement, so people who know you keep knowing you and your history keeps its author. ⚠️ It CANNOT recover a stolen key: whoever holds the secret can rotate exactly as easily as you, and faster, since they need not notice the theft first. This is for planned moves.",
        }),
      ),
      HttpApiEndpoint.post("communityDoorman", "/api/community/doorman", {
        payload: Schema.Struct({
          address: Schema.String,
          /** 1..5, the user's own words about how far they trust this instance. */
          trust: Schema.Finite,
          petname: Schema.optional(Schema.String),
        }),
        success: described(
          Schema.Struct({
            found: Schema.Boolean,
            networkID: Schema.optional(Schema.String),
          }),
          "Who lives at that address, now recorded as a contact with the trust the user declared",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.doorman",
          summary: "Add a doorman by address, with a declared level of trust",
          description:
            "Joining needs no doorman - the network is reachable by LAN, by DNS seed and by peer exchange. This is the OTHER path: naming a host you actually trust and saying how far, which is what the trust ladder is built from and what matters once transactions are involved. It is also the guarantee that the seeds are a convenience rather than a dependency: when every default door is shut, this one still opens.",
        }),
      ),
      HttpApiEndpoint.post("communityDiscover", CommunityPaths.discover, {
        payload: Schema.Struct({ addresses: Schema.optional(Schema.Array(Schema.String)) }),
        success: described(
          Schema.Struct({
            learned: Schema.Finite,
            asked: Schema.Finite,
            peers: Schema.Finite,
            /**
             * 🔴 How the DEFAULT door went, so "found nobody" can name its reason.
             *
             * An empty seed zone and a seed zone full of dead hosts look identical to somebody
             * staring at "found nobody yet", and only one of them is fixed by pasting an address.
             * The transport's own rule applies: *"we know nobody to dial" is a different sentence to
             * a person than "this is not built yet", and it is one they can fix in a minute.*
             */
            seedsAsked: Schema.Boolean,
            seedsFound: Schema.Finite,
            /**
             * 🔴 Why nothing was looked for — present only when discovery REFUSED to run.
             *
             * A refusal that answered zeroes would be indistinguishable from a network with nobody
             * on it, and the two are fixed by opposite actions: one by pasting an address, the
             * other by turning the feature back on. The same argument the transport's `off` reason
             * makes, and an ARRAY for the same reason `CommunityConsent.refusals` returns one —
             * airgapped AND never-consented is a real state, and reporting one of them would send
             * someone to fix a thing that would not help.
             *
             * ⚠️ Declared here because an undeclared field is silently dropped by the response
             * schema and looks exactly like a backend that never sent it.
             */
            refused: Schema.optional(Schema.Array(Schema.String)),
          }),
          "How many peers were learned, how many are now known, and whether the seed door answered",
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
          Schema.Array(Schema.Struct({ name: Schema.String, messages: Schema.Finite })),
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
        // ⚠️ A name carrying line breaks is refused, not cleaned — see the handler for why cleaning
        // would silently join a different room than the one the user clicked.
        error: InvalidRequestError,
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
      HttpApiEndpoint.post("channelListed", CommunityPaths.channelListed, {
        params: ChannelParams,
        payload: Schema.Struct({ listed: Schema.Boolean }),
        success: described(Schema.Boolean, "True when the channel's listing changed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.listed",
          summary: "Let others see you are in this channel",
          description:
            "Discovery and privacy are one question asked from two sides, and this is the user answering it. Unlisted is the default for every channel except the one everybody is in, because the default here is a disclosure rather than a convenience.",
        }),
      ),
      HttpApiEndpoint.get("filterList", CommunityPaths.filters, {
        success: described(Schema.Array(Schema.String), "Words the user does not want to read"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.filter.list",
          summary: "What you have chosen not to see",
          description:
            "Your own words. With no moderator anywhere, blocking a person and muting a topic are the two powers a user has, and this is the second. It hides at READ, so removing a rule brings the messages back.",
        }),
      ),
      HttpApiEndpoint.post("filterAdd", CommunityPaths.filters, {
        payload: Schema.Struct({ pattern: Schema.String }),
        success: described(Schema.Boolean, "True when a new rule was added"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.filter.add",
          summary: "Hide messages containing this",
          description:
            "Matched as a plain, case-insensitive substring — never a regular expression, because a pattern that backtracks catastrophically would hang every channel read for the person who typed it.",
        }),
      ),
      HttpApiEndpoint.delete("filterRemove", CommunityPaths.filters, {
        payload: Schema.Struct({ pattern: Schema.String }),
        success: described(Schema.Boolean, "True when a rule was removed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.filter.remove",
          summary: "Stop hiding it",
          description: "The messages come back — they were never dropped, only hidden.",
        }),
      ),
      HttpApiEndpoint.get("channelsNearby", CommunityPaths.channelsNearby, {
        success: described(Schema.Array(Schema.String), "Channels reachable peers advertise that we are not in"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.nearby",
          summary: "Channels the instances you can reach advertise",
          description:
            "ONE HOP, deliberately: it asks the instances already reachable rather than implying the whole network answered. Multi-hop throttled broadcast is a separate, larger mechanism.",
        }),
      ),
      /**
       * 🔴 The OWNER's view of their own offer, and it is a different question from what peers can
       * fetch. The panel used to read the peer endpoint for this, which coupled the owner's truth to
       * the peer door: airgapped it answered 503, and an offer the current rules refuse read as
       * empty, so the panel told a user who HAD published that they were "not offering anything".
       */
      /**
       * 🔴 The Community app asks this BEFORE showing anything, because the three states it has to
       * tell apart look identical from the outside: never asked, asked and switched off, and
       * airgapped. Only the first should show a warning — re-showing it to somebody who already
       * accepted and then turned the module off would be nagging, not consent.
       */
      HttpApiEndpoint.get("communityParticipation", CommunityPaths.participation, {
        success: described(
          Schema.Struct({
            participating: Schema.Boolean,
            consented: Schema.Boolean,
            enabled: Schema.Boolean,
            /** Every condition currently refusing, in a stable order. Empty when participating. */
            refusals: Schema.Array(Schema.Literals(["never_consented", "switched_off", "airgap"])),
            /**
             * 🔴 Answering peers — a NARROWER permission than participating, with its own switch
             * and its own budget, because it spends tokens rather than bandwidth.
             *
             * ⚠️ Declared here in the same edit as the handler that returns it. Twice now a field
             * has been computed, typed and shipped while this schema dropped it on the way out, and
             * the symptom both times was a feature that looked broken rather than absent.
             */
            answers: Schema.Struct({
              enabled: Schema.Boolean,
              perDay: Schema.Finite,
              /** How many answers have been given today, so a user can see the budget moving. */
              today: Schema.Finite,
            }),
            /**
             * 🔴 The address this instance publishes to the public DHT, so the panel can SHOW what
             * is being advertised. Absent means it looks without advertising, which is the default.
             *
             * ⚠️ Declared in the same edit as the handler that returns it, for the reason written
             * one field up: a value computed and then dropped by this schema reads as a feature that
             * does not work. For an address it would be worse than confusing — a user cannot tell
             * "not published" from "published and not shown", and one of those is a privacy answer.
             */
            announce: Schema.optional(Schema.String),
            /**
             * 🔴 Whether the network CONFIRMED it, which is a different fact from whether the user
             * asked for it. An announcement fails when there is no routing table to publish into, and
             * the panel was asserting "Published" from the config alone — a claim about intention
             * dressed as a claim about the world.
             *
             * ⚠️ Absent means "not attempted yet this session", which is the ordinary state right
             * after a restart and must not read as failure.
             */
            announceConfirmed: Schema.optional(Schema.Boolean),
            /**
             * WHY an announce has not published — `no-sidecar` or `refused`.
             *
             * 🔴 Declared because the panel told every unpublished user the same thing: "check that
             * this address really reaches you from the internet", which is advice for a refused
             * announce and useless on a machine with no directory helper at all (review 1.15). An
             * undeclared field is dropped silently and looks exactly like a backend that never sent it.
             */
            announceReason: Schema.optional(Schema.String),
          }),
          "Whether this instance is on the network, and every reason it is not",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.participation",
          summary: "Whether this instance has joined the community",
          description:
            "An ARRAY of refusals rather than one reason: airgapped AND never-asked is a real state, and reporting only one would send the user to fix something that would not help.",
        }),
      ),
      HttpApiEndpoint.get("offerMineRead", CommunityPaths.offerMine, {
        success: described(
          Schema.Struct({
            offer: Schema.optional(PeerOffer),
            /** False when a stored offer can no longer be served — not the same as having none. */
            servable: Schema.Boolean,
          }),
          "This instance's own offer, servable or not",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.offer.mine",
          summary: "What this instance offers",
          description:
            "The owner's own view. `servable: false` with an offer present means it is stored but the current rules refuse it — an endpoint or payment address an older build accepted — so peers are being served nothing.",
        }),
      ),
      HttpApiEndpoint.post("offerPublish", CommunityPaths.offerMine, {
        payload: Schema.Struct({
          endpoint: Schema.String,
          models: Schema.Array(Schema.String),
          price: Schema.String,
          payTo: Schema.optional(Schema.String),
        }),
        success: described(PeerOffer, "The signed offer, as peers will see it"),
        /**
         * ⚠️ An unservable endpoint is REFUSED here rather than stored and quietly never served.
         * Before this the POST answered 200 with the offer echoed back — indistinguishable from
         * success — while `verify` dropped it on every read, so a user could believe they were
         * advertising a server for as long as they cared to look.
         */
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.offer.publish",
          summary: "Offer a model server to the network",
          description:
            "Signs and stores what this instance offers. `price` is your own words and `payTo` is a Lightning address others can copy — this software generates no invoice, tracks no balance, counts no usage and settles nothing. Whatever is agreed happens between two people, in their own wallets.",
        }),
      ),
      HttpApiEndpoint.delete("offerWithdraw", CommunityPaths.offerMine, {
        success: described(Schema.Boolean, "True once nothing is offered"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.offer.withdraw",
          summary: "Stop offering",
          description:
            "Removes this instance's offer. Peers that already collected it keep their copy until they refresh.",
        }),
      ),
      HttpApiEndpoint.get("offersKnown", CommunityPaths.offersKnown, {
        success: described(Schema.Array(PeerOffer), "Offers collected from peers"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.offer.known",
          summary: "Model servers other people offer",
          description:
            "Each one verified against its signer, so an endpoint cannot have been rewritten in transit. Authenticity is all a signature buys: whether the endpoint exists, serves what it claims, or is still there in an hour are separate questions nothing here answers.",
        }),
      ),
      HttpApiEndpoint.post("directSend", CommunityPaths.directSend, {
        params: ContactParams,
        payload: Schema.Struct({ body: Schema.String }),
        success: described(
          Schema.Struct({ sent: Schema.Boolean, reason: Schema.optional(Schema.String) }),
          "Whether a peer took it — your own copy is kept either way",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.direct.send",
          summary: "Send a direct message",
          description:
            "Fetches the recipient's sealing key from their OWN instance and verifies it against their identity before sealing — taking that key from anywhere else is the substitution attack, where the send succeeds, the ciphertext is valid, and only an unchecked signature would have shown anything wrong. Your copy is stored whether or not it was delivered.",
        }),
      ),
      HttpApiEndpoint.get("directHistory", CommunityPaths.directHistory, {
        params: ContactParams,
        success: described(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              peer: Schema.String,
              direction: Schema.String,
              body: Schema.String,
              at: Schema.Finite,
              receivedAt: Schema.Finite,
            }),
          ),
          "The conversation with one person, most recent first",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.direct.history",
          summary: "Read a conversation",
          description:
            "Plaintext, from this instance's own store. The seal protects the WIRE; the disk is protected by the machine — an instance cannot reopen what it sent, because the key that sealed it was discarded, so its own copy is the only one it will ever have.",
        }),
      ),
      HttpApiEndpoint.get("directList", CommunityPaths.directList, {
        success: described(Schema.Array(Schema.String), "Everyone this instance has exchanged a DM with"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.direct.list",
          summary: "List conversations",
          description: "The peers there is a conversation with.",
        }),
      ),
      HttpApiEndpoint.post("searchChannels", CommunityPaths.searchChannels, {
        payload: Schema.Struct({ terms: Schema.String }),
        success: described(Schema.Array(Schema.String), "Channels found across the network"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.search",
          summary: "Search the network for channels",
          description:
            "Asks a few peers first and widens only if too few answers come back, so a query that is going to be answered costs almost nothing. Reaches beyond directly-connected instances, unlike the one-hop `nearby` list.",
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
        success: described(
          Schema.Struct({
            messages: Schema.Array(CommunityMessageInfo),
            hidden: Schema.Finite,
            /**
             * ⚠️ Declared, because an undeclared field is silently DROPPED by the response schema and
             * reads exactly like a backend that never sent it — the trap `listed` fell into on this
             * same group.
             */
            held: Schema.Finite,
          }),
          "One page of messages, most recently RECEIVED first, how many the user's own filters hid, and how many the room HOLDS",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.history",
          summary: "Read a channel's history",
          description:
            "Gossip only reaches whoever is online, so this local log is what makes a channel readable by someone who was away. Ordered by receive time, never by the author's own claimed timestamp. `hidden` counts what the user's own filter rules removed — reported rather than silent, because a channel that looks empty because of a forgotten rule is indistinguishable from one nobody posts in. `held` is how many the room stores in total: `messages` is ONE PAGE of at most 200, and retention keeps far more, so a caller that treats the page as the whole log will under-report a busy room.",
        }),
      ),
      HttpApiEndpoint.post("channelSync", CommunityPaths.channelSync, {
        params: ChannelParams,
        payload: Schema.Struct({}),
        success: described(
          Schema.Struct({ peers: Schema.Finite, fetched: Schema.Finite }),
          "How many peers answered, and how many messages were new to us",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.channel.sync",
          summary: "Catch up on a channel's history from peers",
          description:
            "Gossip only reaches whoever is online, so an instance that joins late — or was simply switched off for a day — holds nothing from before it arrived. This asks peers what they have, compares it against the local log by bucket summary, and requests only what is missing. Everything fetched enters through the same ingress door a pushed message uses, so a peer we asked gets no more trust than a stranger: signatures are checked, blocked authors are dropped, and the local retention bound still applies. `peers` counts how many answered, `fetched` how many messages were new.",
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
  listedChannels: "/api/community/listed",
  succession: "/api/community/succession",
  search: "/api/community/search",
  ask: "/api/community/ask",
  dm: "/api/community/dm",
  offer: "/api/community/offer",
  /**
   * 🔴 Who lives here — the ONE thing an address must yield before it can become a peer.
   *
   * Discovery used to probe `/global/health`, which the design intended ("this is where a peer
   * already looks to learn who lives at an address") and the auth boundary contradicted: on an
   * instance with a password that path answers 401, so **bootstrap by address failed entirely
   * between secured instances** while every other peer path answered. The vision's "one living node
   * is a complete entry point" quietly did not hold for anyone who set a password.
   *
   * ⚠️ A separate endpoint rather than making `/global/health` public: health also carries
   * `version` and `instanceID`, which a stranger has no business reading. This returns only what a
   * peer must have — the identity to verify signatures against, and the key to seal a message to.
   */
  identity: "/api/community/identity",
} as const

/** A `Proven` message on the wire. Shape only — every rule about it lives at the ingress door. */
const PeerMessage = Schema.Struct({
  channel: Schema.String,
  author: Schema.String,
  at: Schema.Finite,
  body: Schema.String,
  signature: Schema.String,
  nonce: Schema.Finite,
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
/**
 * ⚠️ `received` stays a uniform `true` — the verdict is deliberately not disclosed — and the
 * signature does not change that: it proves the KEY WE ADDRESSED received a message with this id,
 * which is equally true of a message stored, refused as blocked, or dropped as unreadable. Without
 * it, a hostile endpoint claiming a victim's key returned exactly this shape and `sendDirect`
 * reported success for a message nobody would ever read (Codex review P1).
 *
 * ⚠️ Optional on the wire so a peer running an older build still answers rather than failing to
 * decode; the SENDER decides what an unproven ack is worth.
 */
const PeerAck = Schema.Struct({
  received: Schema.Literal(true),
  by: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Finite),
  signature: Schema.optional(Schema.String),
})

/**
 * Community P4 — the three steps of a catch-up, served to whoever asks.
 *
 * 🔴 Addressed by TOPIC throughout, and an unknown topic answers EMPTY rather than "no such channel"
 * — reconciliation needs no such answer to work, and an empty summary simply means there is nothing
 * here to catch up on.
 *
 * ⚠️ **This used to claim a peer therefore "cannot map which rooms this instance is in", and that
 * was measured FALSE (review 1.10).** An unknown topic and a joined-but-EMPTY room are genuinely
 * indistinguishable; a joined room with messages is not — its digests are non-empty. A prober who
 * knows a room name and can post one proof-of-work message into it can confirm membership. The
 * design accepts that (`AGENTS.md`: *being findable is the price*) rather than gating sync on
 * `listed`, which would break catch-up in unlisted rooms; what is not accepted is a comment
 * promising a property the code does not have.
 */
const SyncTopic = Schema.Struct({ topic: Schema.String })
const SyncSummary = Schema.Struct({ buckets: Schema.Array(Schema.String) })
const SyncIdsRequest = Schema.Struct({ topic: Schema.String, buckets: Schema.Array(Schema.Finite) })
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
/**
 * 🔴 A successor statement: the old key saying, in its own signature, "the peer you knew as me is now
 * this other key". Self-verifying, so passing it on grants nothing that could not be checked.
 */
const PeerSuccession = Schema.Struct({
  predecessor: Schema.String,
  successor: Schema.String,
  /**
   * 🔴 A non-negative integer, refused by the SCHEMA rather than only by `verify` (review 1.12).
   *
   * `successionBytes` writes this with `writeBigUInt64BE`, which throws out of range — so `at: -1`
   * on this anonymous door answered 500 and wrote a full stack into the owner's log for free. The
   * store-side guard is the one that must hold; declaring it here as well means the wire says what
   * it means and a decode failure reads as 400 rather than as a crash.
   */
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  signature: Schema.String,
  /**
   * 🔴 The SUCCESSOR's signature over the same bytes (finding 1.4).
   *
   * ⚠️ Declared, because an undeclared field is silently DROPPED — in BOTH directions on this
   * struct, which is payload and response at once. Dropped on the way in, every statement fails to
   * verify and rotation looks like a signing bug; dropped on the way out, we hand peers statements
   * they must refuse.
   */
  successorSignature: Schema.String,
})

/** A sealed direct message on the wire. The body is opaque to everyone but its recipient. */
const PeerDirectMessage = Schema.Struct({
  to: Schema.String,
  from: Schema.String,
  at: Schema.Finite,
  sealed: Schema.Struct({ epk: Schema.String, iv: Schema.String, ct: Schema.String }),
  signature: Schema.String,
  nonce: Schema.Finite,
})

const PeerList = Schema.Struct({
  peers: Schema.Array(Schema.Struct({ networkID: Schema.String, routes: Schema.Array(Schema.String) })),
})

export const CommunityPeerApi = HttpApi.make("communityPeer").add(
  HttpApiGroup.make("communityPeer")
    .add(
      HttpApiEndpoint.post("communityDirectMessage", CommunityPeerPaths.dm, {
        payload: PeerDirectMessage,
        success: described(PeerAck, "Always true — the verdict is deliberately not disclosed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.dm",
          summary: "Accept a direct message",
          description:
            "A message sealed to this instance's published key. Whoever carries it — including a relaying instance — holds ciphertext only; the seal is to the recipient's key, not to the hop. Answered uniformly, so a sender learns nothing about whether it was kept, and nothing about who this instance blocks.",
        }),
      ),
      HttpApiEndpoint.post("communitySearch", CommunityPeerPaths.search, {
        payload: Schema.Struct({
          id: Schema.String,
          terms: Schema.String,
          ttl: Schema.Finite,
          origin: Schema.String,
          /**
           * ⚠️ MUST be declared here or the schema drops it silently and every query arrives
           * unproven — the trap this codebase has already been bitten by once.
           */
          nonce: Schema.Finite,
        }),
        success: described(
          Schema.Struct({ channels: Schema.Array(Schema.String) }),
          "Matching channels this instance advertises, plus whatever it forwarded to",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.search",
          summary: "Ask this instance, and whoever it can reach",
          description:
            "Throttled broadcast search — the owner's decision: no servers, just nodes, and any one living node is a complete entry point. Gnutella collapsed in 2001 because query traffic grew with users × hops, so every query here carries a hop limit, is suppressed by id after the first sighting, and is rate-limited per ORIGIN rather than per sender. A refusal is silent: telling a flooder which control stopped it tells it what to vary.",
        }),
      ),
      HttpApiEndpoint.post("communityAsk", CommunityPeerPaths.ask, {
        payload: Schema.Struct({
          /** Who is asking, so the budget can be shared out and the dealing recorded. */
          /**
           * 🔴 SIGNED by the asker. Without it this field is a claim anybody can make, the
           * per-asker share of the budget bounds only honest peers, and the dealing recorded on
           * answering names whoever the sender felt like naming.
           */
          asker: Schema.String,
          /**
           * 🔴 WHO THIS IS FOR — inside the signature, and checked against this instance's own key.
           *
           * Without it, any instance that received a question could replay it verbatim at every
           * other instance and spend its author's per-asker share — and now their standing — at each
           * one. The cost lands entirely on an innocent third party, which is why "replay only costs
           * the asker their own budget" was the wrong way round.
           */
          to: Schema.String,
          question: Schema.String,
          at: Schema.Finite,
          signature: Schema.String,
        }),
        success: described(
          Schema.Struct({
            /**
             * ⚠️ BOTH fields declared. A success schema drops what it does not name, and a
             * refusal that arrived as an empty answer would read to the asker as "this instance knows
             * nothing" rather than "this instance is not answering today".
             */
            answer: Schema.optional(Schema.String),
            refused: Schema.optional(Schema.String),
            /**
             * 🔴 The refusal, SIGNED — because the asker records a first-hand dealing about this
             * peer either way, and an unsigned refusal let anyone answering at an address write a
             * dealing into our ledger in a victim's name (Codex review P1).
             *
             * ⚠️ Bound to the ask's own signature, so one captured refusal cannot be replayed at
             * every later question. Optional on the wire; an unproven refusal is still reported to
             * the user, it simply earns nobody a dealing.
             */
            refusalAt: Schema.optional(Schema.Finite),
            refusalSignature: Schema.optional(Schema.String),
            /**
             * 🔴 The answer is a CLAIM WE AUTHOR, so it is signed — and every field the
             * signature covers has to travel with it or the asker cannot rebuild the bytes.
             *
             * ⚠️ All optional because a refusal carries none of them, and an undeclared field is
             * dropped silently: the reply would arrive looking exactly like an unsigned one.
             */
            author: Schema.optional(Schema.String),
            at: Schema.optional(Schema.Finite),
            signature: Schema.optional(Schema.String),
          }),
          "An answer, or a NAMED refusal - never silence",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.ask",
          summary: "Ask this instance a question",
          description:
            "The vision's destination: an agent that cannot read a site asks the other agents instead. OFF unless the owner turned it on separately from joining, because this is the one path that spends their tokens on strangers. Bounded three ways - a daily count, a per-asker share of it, and one turn at a time - and the turn itself runs with no tools, no files and no access to the owner's sessions or private messages. A refusal is NAMED rather than silent, because an asker told only 'no' cannot tell a closed door from a spent budget.",
        }),
      ),
      HttpApiEndpoint.post("communitySuccessionTell", CommunityPeerPaths.succession, {
        payload: PeerSuccession,
        success: described(PeerAck, "Always true — a forgery is refused silently, like any other"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.succession.tell",
          summary: "Tell this instance a peer rotated its key",
          description:
            "Someone moved to a new key and proved it with the old one. Verified before it is stored, because an unverified store would hand forgeries to other people on request — worse than believing one ourselves.",
        }),
      ),
      HttpApiEndpoint.get("communitySuccessionKnown", CommunityPeerPaths.succession, {
        success: described(
          Schema.Struct({ statements: Schema.Array(PeerSuccession) }),
          "Rotations this instance can vouch for, each self-verifying",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.succession.known",
          summary: "Rotations this instance knows about",
          description:
            "How a peer that was OFFLINE when someone rotated still finds them. A statement pushed once reaches whoever was listening; keeping and re-serving it is what stops rotation stranding a user against everybody who happened to be closed.",
        }),
      ),
      HttpApiEndpoint.get("communityIdentity", CommunityPeerPaths.identity, {
        /**
         * 🔴 A CHALLENGE the caller chose — Codex review P1.
         *
         * Everything else in this answer is static, so it is a quotation: a hostile endpoint replays
         * a victim's published tuple and every caller believes the route belongs to them. A
         * signature over 32 bytes the answerer could not predict is the only part of this response
         * that means possession.
         *
         * ⚠️ OPTIONAL on the wire, mandatory for our own probes. An instance that asks without one
         * still gets the old shape — a legacy peer stays reachable — while `sync` refuses any answer
         * whose proof does not verify. Unlike the succession co-signature, which had to be a hard
         * break because a one-sided statement is forgeable by design, an unproven identity answer is
         * only useless to the caller.
         */
        query: Schema.Struct({ challenge: Schema.optional(Schema.String) }),
        success: described(
          Schema.Struct({
            networkID: Schema.String,
            sealingKey: Schema.optional(Schema.String),
            sealingSignature: Schema.optional(Schema.String),
            /** Signature over the domain-separated challenge. Absent when none was asked for. */
            proof: Schema.optional(Schema.String),
          }),
          "Who lives at this address, and the key to seal to",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.identity",
          summary: "Who lives at this address",
          description:
            "The first thing a peer asks, and the only thing an address must yield to become a peer. The signature over the sealing key matters: a key taken on trust is one anybody in the path can swap for their own, and the sender would encrypt to the attacker with everything looking correct.",
        }),
      ),
      HttpApiEndpoint.get("communityOffer", CommunityPeerPaths.offer, {
        success: described(
          Schema.Struct({ offer: Schema.optional(PeerOffer) }),
          "What this instance offers, if anything",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.offer",
          summary: "What this instance offers",
          description:
            "A signed advertisement: a model server at an endpoint, on stated terms. The signature protects the ENDPOINT above all — an offer travels through instances that did not write it, and the profitable edit is where the traffic goes. It says what somebody CLAIMS to run; nothing here checks the endpoint exists or is honest.",
        }),
      ),
      HttpApiEndpoint.get("communityListed", CommunityPeerPaths.listedChannels, {
        success: described(
          Schema.Struct({ channels: Schema.Array(Schema.String) }),
          "Channels this instance is willing to be seen in",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "community.peer.listed",
          summary: "Channels this instance advertises",
          description:
            "Channel discovery, and only what the user chose to disclose. Being in a room is not public information — the sync endpoints answer an unknown topic exactly like an empty one so nobody can map this instance's rooms, and this door must not undo that. Unlisted channels are invisible here no matter who asks.",
        }),
      ),
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
    /**
     * 🔴 The consent gate, the airgap and the size cap — attached to the GROUP, so they are decided
     * from the route the router matched rather than from the URL string a stranger chose.
     *
     * Until 2026-08-17 these lived in two router middlewares that compared `request.url` to
     * `CommunityPeerPaths` by string equality, and `/API/community/identity/` was therefore served
     * in full by an instance that had never joined. See `../middleware/peer-door.ts` for the
     * measurements. Attaching it here is also what makes a door added LATER inherit the rules
     * instead of needing to be remembered — the same reason `Authorization` is a group middleware
     * on every other group in this file.
     */
    .middleware(PeerDoor)
    .annotateMerge(
      OpenApi.annotations({
        title: "community-peer",
        description: "Peer-to-peer ingress. Open to strangers on purpose; guarded by proof-of-work and signatures.",
      }),
    ),
)
