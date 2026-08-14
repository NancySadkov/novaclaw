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
  /** Last-known addresses. A key with none is an identity we cannot reach. */
  readonly routes: readonly string[]
  readonly lastSeenAt?: number
  readonly blocked: boolean
  readonly addedAt: number
}

export interface CommunityChannel {
  readonly name: string
  readonly muted: boolean
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

export function communityContacts(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityContact[]>(server, { route: "api/community/contact" })
}

export function communityAddContact(
  server: ServerConnection.HttpBase,
  input: { readonly networkID: string; readonly petname?: string; readonly routes?: readonly string[] },
) {
  return instanceFetch<CommunityContact>(server, { route: "api/community/contact", method: "POST", body: input })
}

export function communityChannels(server: ServerConnection.HttpBase) {
  return instanceFetch<CommunityChannel[]>(server, { route: "api/community/channel" })
}

export function communityJoinChannel(server: ServerConnection.HttpBase, name: string) {
  return instanceFetch<CommunityChannel[]>(server, { route: "api/community/channel", method: "POST", body: { name } })
}

export function communityChannelHistory(server: ServerConnection.HttpBase, name: string) {
  return instanceFetch<CommunityMessage[]>(server, {
    route: `api/community/channel/${encodeURIComponent(name)}/history`,
  })
}
