export * as CommunityMessage from "./message"

import { CommunityTopic } from "./topic"
import { Effect, Schema } from "effect"
import { InstanceIdentityStore } from "../instance-identity-store"

/**
 * Community P4 — the channel message (`notes/spec/community-p2p.md`).
 *
 * The owner's shape: `(Channel_Name, InstanceId, Date, Message)`, broadcast to whoever subscribes.
 * There is no moderator and no server, so **the signature is the only thing that makes any of it
 * mean anything** — without it, "who said this" is a text field anyone can type.
 */

export interface Unsigned {
  /** The channel, e.g. `#NovaClaw`. A name, not a registry entry — nobody owns it. */
  readonly channel: string
  /** The author's network identity, `nid_…`. */
  readonly author: string
  /** Epoch millis, as claimed by the AUTHOR — see `verify`. */
  readonly at: number
  readonly body: string
}

export interface Signed extends Unsigned {
  /** Ed25519 over `canonicalBytes`, base64url. */
  readonly signature: string
}

/**
 * A signed message that also carries its proof-of-work.
 *
 * 🔴 A SEPARATE type, not an optional field, so the compiler enforces what a comment cannot: the
 * log's ingress door accepts only `Proven`, and a caller holding a merely-`Signed` message has to
 * pass through `CommunityWork` to get one. An optional `nonce` would have let every existing call
 * site keep compiling while silently skipping the flood defence.
 *
 * ⚠️ The nonce is NOT inside `canonicalBytes` and is not signed. It binds to the SIGNATURE
 * instead, which is already unique and unforgeable — so work cannot be transplanted between
 * messages, and signing over a nonce would have forced solve-before-sign and a re-solve on any edit.
 */
export interface Proven extends Signed {
  /** Nonce whose digest with the signature clears the difficulty. See `community/work.ts`. */
  readonly nonce: number
}

export class MessageError extends Schema.TaggedErrorClass<MessageError>()("CommunityMessage.MessageError", {
  message: Schema.String,
}) {}

/**
 * Domain separation. A signature must mean "I said this IN THIS PROTOCOL, as a channel message" and
 * nothing else — otherwise bytes signed here could be replayed somewhere else that happens to sign
 * the same shape (an auth challenge, a contact card, a future message type).
 */
const DOMAIN = "novaclaw/community/channel-message/1"

const encoder = new TextEncoder()

/**
 * The exact bytes that get signed.
 *
 * 🔴 LENGTH-PREFIXED, not concatenated or JSON. Plain concatenation makes field boundaries
 * ambiguous: `channel:"#a", body:"b"` and `channel:"#ab", body:""` produce identical bytes, so one
 * signature would validate a message the author never wrote. JSON is no safer — key order and
 * whitespace are not guaranteed to round-trip identically between two implementations, and a
 * signature that depends on a serialiser's mood fails in the field rather than in a test.
 *
 * ⚠️ Both sides MUST derive bytes only through this function. Any second encoder is a second
 * protocol, and the symptom is signatures that "randomly" fail to verify between versions.
 */
export const canonicalBytes = (message: Unsigned): Uint8Array => {
  const parts: Uint8Array[] = []
  const push = (value: string) => {
    const bytes = encoder.encode(value)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length, false)
    parts.push(length, bytes)
  }
  push(DOMAIN)
  push(message.channel)
  push(message.author)
  const at = new Uint8Array(8)
  new DataView(at.buffer).setBigUint64(0, BigInt(Math.trunc(message.at)), false)
  parts.push(at)
  push(message.body)

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Sign a message as this instance. The author is taken from the identity, never from the caller. */
export const sign = Effect.fn("CommunityMessage.sign")(function* (input: {
  readonly channel: string
  readonly body: string
  readonly at?: number
}) {
  const store = yield* InstanceIdentityStore.Service
  const identity = yield* store.identity()
  // ⚠️ `author` is filled from OUR identity rather than accepted as a parameter. A signing helper
  // that let the caller name the author would happily produce a message signed by us and attributed
  // to someone else — which verifies as forged, but only after it has been broadcast.
  const unsigned: Unsigned = {
    channel: input.channel,
    author: identity.networkID,
    at: input.at ?? Date.now(),
    body: input.body,
  }
  const signature = yield* store.sign(canonicalBytes(unsigned))
  return { ...unsigned, signature: Buffer.from(signature).toString("base64url") } satisfies Signed
})

/**
 * Is this message really from the author it names?
 *
 * Pure and total: a hostile peer is an untrusted source of bytes, so every malformed shape returns
 * `false` rather than throwing inside whatever loop is reading the channel.
 *
 * ⚠️ What this does NOT tell you: whether `at` is true. A timestamp is the author's own claim, and
 * an author can lie about it — signing proves they claimed it, never that it happened then. Ordering
 * a channel purely by `at` therefore lets one peer pin itself to the top forever; readers need
 * receive-time as well. There is no authority here to issue trusted timestamps.
 */
export const verify = (message: Signed): boolean => {
  if (typeof message.signature !== "string" || message.signature.length === 0) return false
  if (typeof message.author !== "string" || typeof message.channel !== "string") return false
  if (typeof message.body !== "string" || !Number.isFinite(message.at)) return false
  const signature = Buffer.from(message.signature, "base64url")
  if (signature.length !== 64) return false
  return InstanceIdentityStore.verifySignature(message.author, canonicalBytes(message), signature)
}

/**
 * Verify a message that arrived on a specific channel's topic.
 *
 * 🔴 The channel is checked EXPLICITLY, not assumed from where it arrived. The channel is inside the
 * signed bytes, so a valid signature already binds it — but a reader that skips this check will
 * happily accept a correctly-signed message from `#other` that a hostile peer replayed onto
 * `#NovaClaw`'s topic, and display it as if it were said here.
 *
 * 🔴 The comparison is CANONICAL, and that is a cross-peer correctness rule, not tidiness.
 *
 * A message carries the channel name its author typed. Two instances that joined the same room with
 * different capitalisation hold different strings for it, while the network addresses it by ONE
 * topic — so a literal `!==` here rejects every message from the peer who typed it differently, as
 * `wrong-channel`, on a channel both sides are genuinely in. Nothing local can show this: it needs
 * two instances that disagree about spelling.
 *
 * ⚠️ The SIGNATURE still covers the author's literal spelling, which is unchanged and must be — it
 * is their bytes. Only the "is this the room I asked about" question is asked canonically.
 */
export const verifyOn = (channel: string, message: Signed): boolean =>
  CommunityTopic.canonical(message.channel) === CommunityTopic.canonical(channel) && verify(message)
