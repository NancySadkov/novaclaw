export * as CommunityTopic from "./topic"

import { createHash } from "node:crypto"

/**
 * Community P4 — the channel name ↔ topic mapping (`notes/spec/community-p2p.md`).
 *
 * A gossip network addresses by TOPIC, a fixed-width id, while people speak in names. Every comment
 * in this program has said "the topic id is derived from it by hashing" and nothing has done it —
 * this is that, plus the half nobody thinks about: a message arrives addressed by topic, and a hash
 * cannot be inverted, so the only way back to a name is the list of channels this instance JOINED.
 *
 * 🔴 That asymmetry is a feature. An instance can only resolve topics it subscribes to, so a message
 * for a channel we never joined is unresolvable and therefore un-storable — the `not-subscribed`
 * rule enforced by arithmetic rather than by a check somebody could forget.
 */

/**
 * Names are normalised before hashing: trimmed, lowercased, and a leading `#` made optional.
 *
 * ⚠️ The decision this encodes: `#NovaClaw`, `#novaclaw` and ` #NovaClaw ` are ONE channel. Hashing
 * the literal string would be simpler and would silently create parallel rooms — a user who typed a
 * capital differently would sit alone in a room that looks right, posting to nobody, with no error
 * anywhere. In a network with no directory, nothing would ever tell them.
 *
 * The cost is that a channel cannot be distinguished by case, which nobody wants, and that the
 * DISPLAY name is whatever the user typed while the identity is this canonical form.
 */
export const canonical = (channel: string): string => {
  const trimmed = channel.trim().toLowerCase()
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed
}

/**
 * The topic id a channel name hashes to — 32 bytes, hex.
 *
 * ⚠️ Domain-separated. Without the prefix, a topic id could collide with any other sha256 this
 * program computes over a bare string, and the message id is already `sha256(canonical bytes)`.
 */
export const topicOf = (channel: string): string =>
  createHash("sha256").update(`novaclaw/community/topic/1:${canonical(channel)}`).digest("hex")

/**
 * Which of MY channels does this topic address?
 *
 * `undefined` means "not one of ours" — a hash cannot be inverted, so this is not a lookup failure
 * to retry but a definitive answer: nothing we subscribe to has that id.
 */
export const channelFor = (topic: string, joined: readonly string[]): string | undefined =>
  joined.find((channel) => topicOf(channel) === topic)
