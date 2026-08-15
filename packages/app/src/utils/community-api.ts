import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

/**
 * Community P3/P4 — the forum's client surface (`todo/community-p2p.md`).
 *
 * Instance-global: contacts and channels belong to the install, not to whichever folder is open.
 */

export interface CommunityContact {
  readonly networkID: string
  readonly petname?: string
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
 * ⚠️ `off` names its reason, and the screen must use it: "still being built" and "you switched the
 * network off" are different things to tell a person.
 */
export type CommunityTransportState =
  | { readonly kind: "off"; readonly reason: "airgap" | "no-peers" }
  | { readonly kind: "connecting" }
  | { readonly kind: "online"; readonly peers: number }

export function communityTransportState(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityTransportState>(server, { route: "api/community/transport" })
}

export function communityContacts(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityContact[]>(server, { route: "api/community/contact" })
}

export function communityAddContact(
  server: ServerConnection.HttpBase,
  input: { readonly networkID: string; readonly petname?: string; readonly routes?: readonly string[] },
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
  return instanceFetch<{ readonly learned: number; readonly asked: number; readonly peers: number }>(server, {
    route: "api/community/discover",
    method: "POST",
    body: addresses === undefined ? {} : { addresses },
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
 * ⚠️ Reads the peer-facing endpoint deliberately — it returns exactly what other people see, so the
 * user is shown their advertisement as advertised rather than a local echo of what they typed.
 */
export function communityMyOffer(server: ServerConnection.HttpBase) {
  return instanceFetch<{ readonly offer?: CommunityServiceOffer }>(server, { route: "api/community/offer" })
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

export function communityChannelHistory(server: ServerConnection.HttpBase, name: string) {
  return instanceFetch<CommunityMessage[]>(server, {
    route: `api/community/channel/${encodeURIComponent(name)}/history`,
  })
}
