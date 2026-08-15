export * as CommunityDirect from "./dm"

import { createHash } from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { CommunityDirectMessageTable } from "./dm.sql"
import { CommunitySeal } from "./seal"
import { CommunityWork } from "./work"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { InstanceIdentityStore } from "../instance-identity-store"

/**
 * Community P3 — 1:1 chat.
 *
 * 🔴 **A DM is addressed to one KEY, never to a topic.** That is the rule §11 got right and the only
 * part of it that survived: gossiped, a DM would reach every subscriber of some topic and would then
 * need an app-layer seal to be private at all. Addressed directly, it needs one anyway — because the
 * shipped transport encrypts to an ADDRESS, so a relay holds the plaintext — but it needs exactly one
 * seal for one recipient rather than a broadcast that everybody stores and nobody can read.
 *
 * Three separate guarantees, and it is worth keeping them apart because they fail differently:
 *
 *   - **who wrote it** — the Ed25519 signature over the envelope. Unchanged from channel messages.
 *   - **who can read it** — the X25519 seal, to a key VERIFIED as belonging to that identity.
 *   - **what it costs to send** — proof-of-work, exactly as on the channel door, because the inbound
 *     route is open to strangers and a DM inbox is as floodable as a room.
 */

export interface Unsigned {
  /** Recipient `nid_…`. */
  readonly to: string
  /** Author `nid_…`, filled from OUR identity when signing — never accepted from a caller. */
  readonly from: string
  readonly at: number
  /** The sealed body. Opaque to everyone but the recipient, including any relay. */
  readonly sealed: CommunitySeal.Envelope
}

export interface Signed extends Unsigned {
  readonly signature: string
}

/** Signed AND work-proven — the only shape the inbound door accepts, as with channel messages. */
export interface Proven extends Signed {
  readonly nonce: number
}

export interface Stored {
  readonly id: string
  readonly peer: string
  readonly direction: "in" | "out"
  readonly body: string
  readonly at: number
  readonly receivedAt: number
}

/** Why an incoming DM was not stored. */
export type Rejection = "unverified" | "unproven" | "not-for-us" | "unreadable" | "duplicate" | "too-large"

/** Same bound as a channel message: the door is open to strangers, so the body cannot be unbounded. */
export const MAX_BODY_BYTES = 8 * 1024

const DOMAIN = "novaclaw/community/direct-message-envelope/1"
const encoder = new TextEncoder()

/**
 * The exact bytes signed.
 *
 * 🔴 LENGTH-PREFIXED, for the reason the channel envelope documents: plain concatenation makes field
 * boundaries ambiguous, so one signature would validate a message its author never wrote. The SEALED
 * parts are inside the signature too — a signature over only the recipient and timestamp would let
 * anyone swap the ciphertext for another and keep the author's name on it.
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
  push(message.to)
  push(message.from)
  const at = new Uint8Array(8)
  new DataView(at.buffer).setBigUint64(0, BigInt(Math.trunc(message.at)), false)
  parts.push(at)
  push(message.sealed.epk)
  push(message.sealed.iv)
  push(message.sealed.ct)

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Is this really from the author it names? Pure and total — a peer is untrusted bytes. */
export const verify = (message: Signed): boolean => {
  if (typeof message.signature !== "string" || message.signature.length === 0) return false
  if (typeof message.to !== "string" || typeof message.from !== "string") return false
  if (!Number.isFinite(message.at)) return false
  const sealed = message.sealed
  if (typeof sealed?.epk !== "string" || typeof sealed?.iv !== "string" || typeof sealed?.ct !== "string")
    return false
  const signature = Buffer.from(message.signature, "base64url")
  if (signature.length !== 64) return false
  return InstanceIdentityStore.verifySignature(message.from, canonicalBytes(message), signature)
}

export const messageID = (message: Signed): string =>
  createHash("sha256").update(canonicalBytes(message)).digest("hex")

export interface Interface {
  /**
   * Seal, sign, prove and store a message for `to` — returning it ready to hand to a transport.
   *
   * ⚠️ Needs the recipient's sealing key AND the signature proving it is theirs. Sealing to an
   * unverified key is the silent substitution: valid ciphertext, delivered, readable by whoever
   * supplied the key.
   */
  readonly compose: (input: {
    readonly to: string
    readonly sealingKey: string
    readonly sealingSignature: string
    readonly body: string
  }) => Effect.Effect<{ readonly message: Proven; readonly stored: Stored } | { readonly rejected: Rejection }>
  /** THE inbound door for a direct message. Every rule lives here, as `record` does for channels. */
  readonly receive: (
    message: Proven,
  ) => Effect.Effect<{ readonly stored: Stored } | { readonly rejected: Rejection }>
  /** A conversation with one person, most recent first by RECEIVED time. */
  readonly history: (peer: string, limit?: number) => Effect.Effect<ReadonlyArray<Stored>>
  /** Everyone we have exchanged a DM with. */
  readonly conversations: () => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityDirect") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const identity = yield* InstanceIdentityStore.Service

    const rowStored = (row: typeof CommunityDirectMessageTable.$inferSelect): Stored => ({
      id: row.id,
      peer: row.peer,
      direction: row.direction === "out" ? "out" : "in",
      body: row.body,
      at: row.claimed_at,
      receivedAt: row.received_at,
    })

    const keep = Effect.fn("CommunityDirect.keep")(function* (input: {
      readonly message: Signed
      readonly peer: string
      readonly direction: "in" | "out"
      readonly body: string
    }) {
      const id = messageID(input.message)
      const receivedAt = Date.now()
      const inserted = yield* db
        .insert(CommunityDirectMessageTable)
        .values({
          id,
          peer: input.peer,
          direction: input.direction,
          body: input.body,
          claimed_at: input.message.at,
          received_at: receivedAt,
          signature: input.message.signature,
        })
        .onConflictDoNothing()
        .returning({ id: CommunityDirectMessageTable.id })
        .all()
        .pipe(Effect.orDie)
      if (inserted.length === 0) return undefined
      return {
        id,
        peer: input.peer,
        direction: input.direction,
        body: input.body,
        at: input.message.at,
        receivedAt,
      } satisfies Stored
    })

    return Service.of({
      compose: Effect.fn("CommunityDirect.compose")(function* (input) {
        if (Buffer.byteLength(input.body, "utf8") > MAX_BODY_BYTES) return { rejected: "too-large" as const }
        /**
         * 🔴 The recipient's key is VERIFIED against their identity before anything is sealed to it.
         *
         * This is the silent attack: a substituted sealing key produces perfectly valid ciphertext,
         * so the sender sees success, the recipient may even receive a re-sealed copy, and the only
         * evidence that anything went wrong is a signature nobody checked.
         */
        if (!InstanceIdentityStore.verifySealingKey(input.to, input.sealingKey, input.sealingSignature))
          return { rejected: "unverified" as const }

        const sealed = CommunitySeal.seal(input.sealingKey, input.body)
        if (sealed === undefined) return { rejected: "unverified" as const }

        const self = (yield* identity.identity()).networkID
        // ⚠️ `from` comes from OUR identity, never from a caller: a composer that accepted an author
        // would happily sign as us and attribute to someone else.
        const unsigned: Unsigned = { to: input.to, from: self, at: Date.now(), sealed }
        const signature = yield* identity.sign(canonicalBytes(unsigned))
        const signed: Signed = { ...unsigned, signature: signature.toString("base64url") }
        const proven = CommunityWork.prove(signed)
        if (proven === undefined) return { rejected: "unproven" as const }

        /**
         * ⚠️ We store OUR OWN plaintext, because we can never recover it from the envelope: the
         * ephemeral key that sealed it was discarded, which is the forward secrecy working. An outbox
         * that showed nothing but ciphertext would be the price of that property paid by the wrong
         * person.
         */
        const stored = yield* keep({ message: signed, peer: input.to, direction: "out", body: input.body })
        return stored === undefined
          ? { rejected: "duplicate" as const }
          : { message: proven, stored }
      }),

      receive: Effect.fn("CommunityDirect.receive")(function* (message: Proven) {
        // Order as on the channel door, and for the measured reason: work costs 0.83 µs to check and
        // ~49 ms to produce, a signature costs 41 µs and a forgery is free — so the cheap check that
        // imposes a cost goes first.
        if (!CommunityWork.verify(message.signature, message.nonce)) return { rejected: "unproven" as const }
        if (!verify(message)) return { rejected: "unverified" as const }

        const self = (yield* identity.identity()).networkID
        // Not addressed to us: refuse rather than store something we cannot read and were not sent.
        if (message.to !== self) return { rejected: "not-for-us" as const }

        const body = yield* identity.openSealed(message.sealed)
        // Addressed to us and yet unreadable means it was sealed to a key we do not hold — an old
        // key, or a substitution. Either way it is not something to keep as if it were a message.
        if (body === undefined) return { rejected: "unreadable" as const }
        if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return { rejected: "too-large" as const }

        const stored = yield* keep({ message, peer: message.from, direction: "in", body })
        return stored === undefined ? { rejected: "duplicate" as const } : { stored }
      }),

      history: Effect.fn("CommunityDirect.history")(function* (peer: string, limit = 200) {
        const rows = yield* db
          .select()
          .from(CommunityDirectMessageTable)
          .where(eq(CommunityDirectMessageTable.peer, peer))
          .orderBy(desc(CommunityDirectMessageTable.received_at), desc(CommunityDirectMessageTable.id))
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.map(rowStored)
      }),

      conversations: Effect.fn("CommunityDirect.conversations")(function* () {
        const rows = yield* db
          .selectDistinct({ peer: CommunityDirectMessageTable.peer })
          .from(CommunityDirectMessageTable)
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => row.peer)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, InstanceIdentityStore.node] })
