import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

/**
 * Community P3/P4 — the forum's client surface (`notes/spec/community-p2p.md`).
 *
 * Instance-global: contacts and channels belong to the install, not to whichever folder is open.
 */

export interface CommunityContact {
  readonly networkID: string
  readonly petname?: string
  /**
   * 🔴 The user's own rating of this peer, 1..5. Absent means never rated — which is the
   * ordinary state of everyone met through peer exchange, and NOT the same as untrusted.
   *
   * A declaration, never a computation: the honesty ledger may not move it, because a user outranks
   * the ledger.
   */
  readonly trust?: number
  /**
   * Keys this peer has rotated away from, newest first — sent by `contactList` only.
   *
   * Attribution needs them: a message carries whichever key its author held when they signed it, so
   * everything written before a rotation is signed by a key that is no longer their identity.
   */
  readonly formerIDs?: readonly string[]
  /** Last-known addresses. A key with none is an identity we cannot reach. */
  readonly routes: readonly string[]
  readonly lastSeenAt?: number
  readonly blocked: boolean
  readonly addedAt: number
}

export interface CommunityChannel {
  readonly name: string
  readonly muted: boolean
  /** Whether other instances are told we are in it. Unlisted unless the user says otherwise. */
  readonly listed: boolean
}

export interface CommunityMessage {
  readonly id: string
  readonly channel: string
  readonly author: string
  /** The author's own claimed time. */
  readonly at: number
  /** When this instance received it — the sort key, and the only time we can vouch for. */
  readonly receivedAt: number
  readonly body: string
}

/**
 * Whether anything can carry a message right now.
 *
 * ⚠️ `off` names its reason and the screen must use it — the three are different things to tell a
 * person: `not-joined` (this instance never accepted what joining costs, so it does not reach out at
 * all), `airgap` (its owner switched the network off), and `no-peers` (willing and able, but nobody
 * to dial — the one they can fix in a minute).
 *
 * 🔴 `not-joined` was MISSING here while the server has declared it since the consent gate shipped.
 * Nothing consumed it, so nothing failed: the panel gates on `participation` before this is read.
 * But a narrower type than the wire sends is a trap set for the next reader, who will handle the two
 * cases the type admits and fall through on the one every fresh install is in.
 */
export type CommunityTransportState =
  | { readonly kind: "off"; readonly reason: "airgap" | "no-peers" | "not-joined" }
  | { readonly kind: "connecting" }
  | { readonly kind: "online"; readonly peers: number }

/**
 * 🔴 **NOTHING IN THIS FILE SWALLOWS A FAILURE — reads and actions alike.**
 *
 * The first repair of *"one failed read took the whole application down"* put a `softRead` helper
 * here: it caught, `console.warn`ed and returned a fallback (`[]`, or `undefined as never`). That
 * stopped the root `ErrorBoundary` crash and bought a second, quieter defect in exchange — the
 * fallback is **the same value a successful empty answer produces**, so an instance that could not
 * be asked rendered as a community with nobody in it. Its own comment said as much (*"an empty panel
 * with nothing in the console is indistinguishable from an empty community"*) and then answered it
 * in the console, which is not a surface a user reads.
 *
 * ⚠️ **It was worse than a wrong count.** `communityParticipation`'s fallback was `undefined`, and
 * the panel's door gate read `undefined` as *joined* — so a failed read showed the full community
 * panel, with a "Turn off" button, to an instance that had never joined. AGENTS.md: **joining is a
 * decision, not a default.** A helper that returns a plausible value on failure cannot avoid picking
 * one of these lies; the only fix is to stop producing a value at all.
 *
 * **So a rejection travels, and the CALLER classifies it.** `utils/settled-resource.ts` is the one
 * place that turns a rejection into a reading a screen can render — `failed` distinct from `empty`,
 * with an accessor that still cannot throw, which is what kept the ErrorBoundary crash closed. Every
 * read here is consumed through `createSettledResource` in `pages/home-screen/community-network.tsx`
 * (the only consumer of these reads), and `community-api.test.ts` is what keeps it that way.
 *
 * ⚠️ **Do not reintroduce a `.catch` here, in either direction.** A read that swallows hides the
 * outage from `failed`; an action that swallows tells the user their message was posted when it was
 * not. Ruling 2 (`notes/reports/decisions-v0.2.0.md`) forbids both halves.
 */

export function communityTransportState(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityTransportState>(server, { route: "api/community/transport" })
}

export function communityContacts(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityContact[]>(server, { route: "api/community/contact" })
}

export function communityAddContact(
  server: ServerConnection.HttpBase,
  input: {
    readonly networkID: string
    readonly petname?: string
    readonly routes?: readonly string[]
    /**
     * ⚠️ Re-adding an EXISTING contact updates them, which is how a rating is changed without a
     * second endpoint — and omitting this leaves any existing rating alone rather than clearing it.
     */
    readonly trust?: number
  },
) {
  return instanceFetch<CommunityContact>(server, { route: "api/community/contact", method: "POST", body: input })
}

/**
 * Block or unblock a peer.
 *
 * 🔴 With no moderator anywhere in this network, this is the ONLY power a user has over what they
 * receive — and it acts at ingress, so a blocked peer's messages are refused as they arrive rather
 * than stored and hidden.
 */
export function communitySetBlocked(server: ServerConnection.HttpBase, networkID: string, blocked: boolean) {
  return instanceFetch<boolean>(server, {
    route: `api/community/contact/${encodeURIComponent(networkID)}/block`,
    method: "POST",
    body: { blocked },
  })
}

/**
 * Remove a peer from the address book.
 *
 * ⚠️ Does NOT delete anything they said — their messages stay in the log, because forgetting who
 * someone is and erasing what happened are different acts, and only one of them was asked for.
 */
export function communityForgetContact(server: ServerConnection.HttpBase, networkID: string) {
  return instanceFetch<boolean>(server, {
    route: `api/community/contact/${encodeURIComponent(networkID)}`,
    method: "DELETE",
  })
}

export function communityChannels(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityChannel[]>(server, { route: "api/community/channel" })
}

export function communityJoinChannel(server: ServerConnection.HttpBase, name: string) {
  return instanceFetch<CommunityChannel[]>(server, { route: "api/community/channel", method: "POST", body: { name } })
}

/**
 * Say something. `delivered` reports whether a transport took it — never whether it was read, since
 * nothing in a serverless network can promise that.
 */
/**
 * Find other instances: LAN sightings, any address given, then peer exchange with everyone reachable.
 *
 * ⚠️ An ADDRESS is enough — the instance there tells us its own key. Nobody types a `nid_…`.
 */
export function communityDiscover(server: ServerConnection.HttpBase, addresses?: readonly string[]) {
  return instanceFetch<{
    readonly learned: number
    readonly asked: number
    readonly peers: number
    /** Whether the DNS seed door was consulted, and how many addresses it gave. */
    readonly seedsAsked: boolean
    readonly seedsFound: number
    /**
     * Every reason discovery refused to look — present only when it did.
     *
     * ⚠️ Zeroes would read as "the network is empty", which a user fixes by pasting an address, while
     * this is fixed by turning the feature on. Sending somebody to the wrong repair is what naming
     * the refusal prevents.
     */
    readonly refused?: readonly string[]
  }>(server, {
    route: "api/community/discover",
    method: "POST",
    body: addresses === undefined ? {} : { addresses },
  })
}

/**
 * Name a DOORMAN: an address you were given, and how far you trust whoever answers there.
 *
 * 🔴 Joining needs none of this — LAN, DNS seeds and peer exchange all work with nobody's
 * permission. This is the other path, the one that matters once transactions do, and it is also what
 * makes the seed list a convenience rather than a dependency: when every default door is shut, this
 * one still opens.
 *
 * ⚠️ An ADDRESS, never a key. The instance there tells us who it is; asking a person to type 47
 * characters of base64 is what principle 12 exists to forbid.
 */
export function communityDoorman(
  server: ServerConnection.HttpBase,
  input: { readonly address: string; readonly trust: number; readonly petname?: string },
) {
  return instanceFetch<{ readonly found: boolean; readonly networkID?: string }>(server, {
    route: "api/community/doorman",
    method: "POST",
    body: { ...input },
  })
}

/**
 * Move this instance to a new key and tell every reachable peer.
 *
 * ⚠️ Cannot undo a stolen key — whoever holds the secret can do this too, and sooner. Planned moves.
 */
export function communityRotate(server: ServerConnection.HttpBase) {
  return instanceFetch<{ readonly networkID: string; readonly told: number }>(server, {
    route: "api/community/rotate",
    method: "POST",
  })
}

export interface CommunityServiceOffer {
  readonly kind: string
  readonly endpoint: string
  readonly models: readonly string[]
  /** The offerer's own words. This software moves no money and enforces no terms. */
  readonly price: string
  /** A Lightning address the offerer published. Copyable; this software never pays it. */
  readonly payTo: string
  readonly from: string
  readonly at: number
  readonly signature: string
}

/** Model servers other people offer, each verified against its signer. */
export function communityOffers(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityServiceOffer[]>(server, { route: "api/community/offers" })
}

/**
 * What THIS instance currently offers, if anything.
 *
 * 🔴 Reads the OWNER's endpoint, not the peer-facing one. It used to read the peer door on the
 * reasoning that this shows the advertisement "as others see it" — good intent, wrong coupling: every
 * policy on that door then rewrites what the owner is told. Observed both ways on a running instance:
 * airgapped it answered 503, and an offer the current rules refuse read as empty, so a user who HAD
 * published was told "You are not offering anything."
 *
 * `servable: false` alongside an offer is the case that matters — stored, but peers are getting
 * nothing — and it is why this cannot be a bare optional.
 */
export type CommunityRefusal = "never_consented" | "switched_off" | "airgap"

/**
 * Whether this instance has joined the community — asked BEFORE anything else is shown.
 *
 * The three not-participating states look identical from outside and must not be shown the same
 * way: never asked deserves the warning, switched-off deserves a switch, and airgapped deserves
 * neither because flipping community settings would not change it.
 */
export function communityParticipation(server: ServerConnection.HttpBase) {
  return instanceFetch<{
    readonly participating: boolean
    readonly consented: boolean
    readonly enabled: boolean
    readonly refusals: ReadonlyArray<CommunityRefusal>
    readonly answers: {
      readonly enabled: boolean
      readonly perDay: number
      readonly today: number
    }
    /** The address published to the public DHT, when the user has set one. */
    readonly announce?: string
    /**
     * Whether the network CONFIRMED that address — a different fact from whether the user asked for
     * it. Absent means no attempt has been made yet this session, which is the ordinary state after a
     * restart and must not be shown as failure.
     */
    readonly announceConfirmed?: boolean
    /** `no-sidecar` when this build has no directory helper, `refused` when one tried and failed. */
    readonly announceReason?: string
  }>(server, { route: "api/community/participation" })
}

/**
 * Record that the user read the warning and accepted it, or flip the app's own switch.
 *
 * ⚠️ Goes through `/config` because this is a PRIVILEGED setting, beside the airgap and telemetry:
 * it has consequences off this machine. Routing it through a community-specific endpoint would have
 * quietly given it a second, ungated path.
 */
export function communitySetParticipation(
  server: ServerConnection.HttpBase,
  value: {
    readonly consented?: boolean
    readonly enabled?: boolean
    /**
     * 🔴 Answering peers — a SEPARATE decision from joining, because it spends tokens rather
     * than bandwidth. Nothing here may turn it on as a side effect of joining.
     */
    readonly answers?: { readonly enabled?: boolean; readonly perDay?: number }
    /**
     * 🔴 The address this instance publishes to the public DHT — a decision above joining and
     * above answering: it is read by people who never talk to us, and it outlives the request that
     * created it. Empty string clears it.
     */
    readonly announce?: string
  },
) {
  return instanceFetch<unknown>(server, { route: "config", method: "PATCH", body: { community: value } })
}

export function communityMyOffer(server: ServerConnection.HttpBase) {
  return instanceFetch<{ readonly offer?: CommunityServiceOffer; readonly servable: boolean }>(server, {
    route: "api/community/offer/mine",
  })
}

/** Offer a model server to the network. `price` is free text — no rails behind it. */
export function communityPublishOffer(
  server: ServerConnection.HttpBase,
  input: {
    readonly endpoint: string
    readonly models: readonly string[]
    readonly price: string
    readonly payTo?: string
  },
) {
  return instanceFetch<CommunityServiceOffer>(server, {
    route: "api/community/offer/mine",
    method: "POST",
    body: input,
  })
}

export function communityWithdrawOffer(server: ServerConnection.HttpBase) {
  return instanceFetch<boolean>(server, { route: "api/community/offer/mine", method: "DELETE" })
}

export interface CommunityDirectMessage {
  readonly id: string
  readonly peer: string
  readonly direction: string
  readonly body: string
  readonly at: number
  readonly receivedAt: number
}

/** Everyone there is a conversation with. */
export function communityConversations(server: ServerConnection.HttpBase) {
  return instanceFetch<string[]>(server, { route: "api/community/direct" })
}

/** One conversation, most recent first. Plaintext from this instance's own store. */
export function communityDirectHistory(server: ServerConnection.HttpBase, networkID: string) {
  return instanceFetch<CommunityDirectMessage[]>(server, {
    route: `api/community/direct/${encodeURIComponent(networkID)}/history`,
  })
}

/**
 * Send a direct message.
 *
 * ⚠️ The recipient's sealing key is fetched from THEIR instance and verified server-side — never
 * supplied from here, because a key taken on trust is the substitution attack.
 */
export function communitySendDirect(server: ServerConnection.HttpBase, networkID: string, body: string) {
  return instanceFetch<{ readonly sent: boolean; readonly reason?: string }>(server, {
    route: `api/community/direct/${encodeURIComponent(networkID)}`,
    method: "POST",
    body: { body },
  })
}

/** Words the user chose not to read. Their own — never anything an agent or a channel supplied. */
export function communityFilters(server: ServerConnection.HttpBase) {
  return instanceFetch<string[]>(server, { route: "api/community/filter" })
}

export function communityAddFilter(server: ServerConnection.HttpBase, pattern: string) {
  return instanceFetch<boolean>(server, { route: "api/community/filter", method: "POST", body: { pattern } })
}

export function communityRemoveFilter(server: ServerConnection.HttpBase, pattern: string) {
  return instanceFetch<boolean>(server, { route: "api/community/filter", method: "DELETE", body: { pattern } })
}

/** Channels this instance left but still holds messages for. */
export function communityArchivedChannels(server: ServerConnection.HttpBase) {
  return instanceFetch<{ readonly name: string; readonly messages: number }[]>(server, {
    route: "api/community/channel/archived",
  })
}

/**
 * Stop subscribing. The instance KEEPS the history — see the endpoint's note.
 */
export function communityLeaveChannel(server: ServerConnection.HttpBase, name: string) {
  return instanceFetch<boolean>(server, {
    route: `api/community/channel/${encodeURIComponent(name)}`,
    method: "DELETE",
  })
}

/** Muting keeps the subscription and quiets the channel — deliberately not the same as leaving. */
export function communityMuteChannel(server: ServerConnection.HttpBase, name: string, muted: boolean) {
  return instanceFetch<boolean>(server, {
    route: `api/community/channel/${encodeURIComponent(name)}/mute`,
    method: "POST",
    body: { muted },
  })
}

/** Let other instances see we are in this channel — or stop letting them. */
export function communityListChannel(server: ServerConnection.HttpBase, name: string, listed: boolean) {
  return instanceFetch<boolean>(server, {
    route: `api/community/channel/${encodeURIComponent(name)}/listed`,
    method: "POST",
    body: { listed },
  })
}

/** Channels the instances we can reach advertise — one hop, not the whole network. */
export function communityNearbyChannels(server: ServerConnection.HttpBase) {
  return instanceFetch<string[]>(server, { route: "api/community/nearby" })
}

export function communityPost(server: ServerConnection.HttpBase, channel: string, body: string) {
  return instanceFetch<{ id: string; stored: boolean; delivered: boolean }>(server, {
    route: `api/community/channel/${encodeURIComponent(channel)}/post`,
    method: "POST",
    body: { body },
  })
}

/**
 * A channel's messages, plus how many the user's own filters hid.
 *
 * ⚠️ The count travels with them: a room that looks quiet because of a rule its reader forgot writing
 * is indistinguishable from one nobody posts in.
 */
export function communityChannelHistory(server: ServerConnection.HttpBase, name: string) {
  return instanceFetch<{
    readonly messages: CommunityMessage[]
    readonly hidden: number
    /** How many the room HOLDS. `messages` is one page of at most 200. */
    readonly held: number
  }>(server, {
    route: `api/community/channel/${encodeURIComponent(name)}/history`,
  })
}

/**
 * Ask peers for what this channel had before we arrived.
 *
 * ⚠️ Answers `{peers:0,fetched:0}` rather than failing when the community is off — the gate lives in
 * core, so a caller never has to ask whether it is allowed to try.
 */
export function communityChannelSync(server: ServerConnection.HttpBase, name: string) {
  return instanceFetch<{ readonly peers: number; readonly fetched: number }>(server, {
    route: `api/community/channel/${encodeURIComponent(name)}/sync`,
    method: "POST",
    body: {},
  })
}
