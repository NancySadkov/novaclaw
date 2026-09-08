export * as CommunityDirect from "./dm"

import { createHash } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { CommunityDirectMessageTable } from "./dm.sql"
import { CommunitySeal } from "./seal"
import { CommunityWork } from "./work"
import { CommunityContacts } from "./contacts"
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
export type Rejection =
  | "unverified"
  | "unproven"
  | "not-for-us"
  | "unreadable"
  | "duplicate"
  | "too-large"
  | "blocked"

/** Same bound as a channel message: the door is open to strangers, so the body cannot be unbounded. */
export const MAX_BODY_BYTES = 8 * 1024

/**
 * 🔴 How many direct messages this instance keeps. The channel log has had this since it was written;
 * the DM store had nothing, through the SAME open door.
 *
 * Proof-of-work meters the rate — measured, a flooder falls from 9.8k msg/s to about 20 — but metering
 * is not a storage bound. At that ceiling and this body size it is still gigabytes a day, arriving
 * from a stranger who never has to be anybody.
 *
 * ⚠️ A per-CONVERSATION cap would not have closed it, and that is the interesting part: an attacker
 * mints a fresh key per conversation, so every thread stays under a per-thread limit while the total
 * grows without end. The bound has to be global.
 *
 * ⚠️ Eviction protects CONTACTS first, then recency. A flood from strangers must never be able to push
 * out the conversation the user actually cares about — a bound that discards real mail to make room
 * for spam is worse than no bound, because it hands the attacker the thing they wanted.
 */
export const MAX_DIRECT_MESSAGES = 20_000

/**
 * 🔴 How far OVER the bound the store is allowed to drift before it is trimmed, and this exists
 * because the first version of this bound recreated the seventh finding of the adversarial pass —
 * a ceiling that made the thing it bounded more dangerous.
 *
 * Measured at the bound: the trim costs **31.9 ms**, against 0.83 µs for a work check. Run on every
 * arrival it would have cost us almost exactly what proof-of-work costs the ATTACKER (49 ms), which
 * cancels the one defence the door has — they would be paying to make us pay.
 *
 * ⚠️ So the trim is guarded by a COUNT (0.014 ms) and, when it does run, cuts all the way to
 * `MAX_DIRECT_MESSAGES` rather than shaving one row. That amortises 31.9 ms across this many
 * messages — about 0.08 ms each — and the cost of the slack is 500 extra rows on disk.
 */
export const PRUNE_SLACK = 500

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

/**
 * 🔴 **The delivery acknowledgement, signed** (Codex review P1).
 *
 * The DM door answers `{received:true}` to everybody, deliberately: a sender must not learn whether
 * their message was kept, and must not be able to probe who this user blocks. But an UNSIGNED
 * uniform ack is also what a black hole returns — a hostile endpoint that claimed a victim's key
 * accepted ciphertext it could not open, said `received:true`, and `sendDirect` reported success to
 * the user for a message nobody would ever read.
 *
 * ⚠️ Signing does not weaken the indistinguishability, and that is why this shape and not a verdict:
 * it says "the holder of this key received a message with this id", which is true whether the
 * message was stored, refused as blocked or dropped as unreadable. A blocked sender is answered with
 * the same signed ack as anyone else — refusing to sign for them would leak the block that the
 * uniform reply exists to hide.
 */
const DELIVERY_DOMAIN = "novaclaw/community/delivery/1"

export interface UnsignedDelivery {
  /** Who received it — the key whose possession this proves. */
  readonly recipient: string
  /** Who sent it, so an ack cannot be lifted from somebody else's delivery. */
  readonly sender: string
  /** The message id: unique per message, so an ack cannot be replayed for the next one. */
  readonly message: string
  readonly at: number
}

export interface SignedDelivery extends UnsignedDelivery {
  readonly signature: string
}

export const deliveryBytes = (input: UnsignedDelivery): Uint8Array => {
  const parts: Uint8Array[] = []
  const push = (value: string) => {
    const bytes = encoder.encode(value)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length, false)
    parts.push(length, bytes)
  }
  push(DELIVERY_DOMAIN)
  push(input.recipient)
  push(input.sender)
  push(input.message)
  const at = new Uint8Array(8)
  new DataView(at.buffer).setBigUint64(0, BigInt(Math.trunc(input.at)), false)
  parts.push(at)
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** True only if the peer we addressed really received THIS message from US. */
export const verifyDelivery = (
  ack: SignedDelivery,
  expected: { readonly recipient: string; readonly sender: string; readonly message: string },
): boolean => {
  if (typeof ack.signature !== "string" || ack.signature.length === 0) return false
  if (ack.recipient !== expected.recipient) return false
  if (ack.sender !== expected.sender) return false
  if (ack.message !== expected.message) return false
  if (!Number.isSafeInteger(ack.at) || ack.at < 0) return false
  const signature = Buffer.from(ack.signature, "base64url")
  if (signature.length !== 64) return false
  return InstanceIdentityStore.verifySignature(ack.recipient, deliveryBytes(ack), signature)
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
    const contacts = yield* CommunityContacts.Service

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

      // ⚠️ The cheap guard comes first, and it is the whole reason this is affordable — see
      // `PRUNE_SLACK`. Reaching the trim on every arrival would hand an attacker a 31.9 ms bill for
      // the 49 ms they already pay, which is not a defence, it is a trade.
      const held = yield* db.$count(CommunityDirectMessageTable).pipe(Effect.orDie)
      if (held > MAX_DIRECT_MESSAGES + PRUNE_SLACK)
        // Trimmed by IDENTITY, never a time cutoff — a burst inside one millisecond makes a cutoff
        // match everything or nothing, which the message log and the peer table both learned already.
        yield* db
          .delete(CommunityDirectMessageTable)
          .where(
            sql`${CommunityDirectMessageTable.id} NOT IN (
              SELECT id FROM ${CommunityDirectMessageTable} AS m
              ORDER BY
                (SELECT COUNT(*) FROM community_contact c WHERE c.network_id = m.peer) DESC,
                m.received_at DESC,
                m.rowid DESC
              LIMIT ${MAX_DIRECT_MESSAGES}
            )`,
          )
          .run()
          .pipe(Effect.orDie)

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

        /**
         * ⚠️ Our own identity is read BEFORE the seal now, because the seal is bound to the PAIR
         * (finding 1.8): ciphertext that named only its recipient could be re-signed by a third
         * party and filed under their name in the recipient's history.
         */
        const self = (yield* identity.identity()).networkID
        const sealed = CommunitySeal.seal(
          input.sealingKey,
          input.body,
          CommunitySeal.envelopeAAD(self, input.to),
        )
        if (sealed === undefined) return { rejected: "unverified" as const }
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

        /**
         * 🔴 Blocking applies HERE too, and it did not until this was probed on two live instances:
         * a blocked sender's message arrived `{"sent":true}` and appeared in the recipient's history.
         * The handler above already drops the verdict so a stranger cannot learn whether they are
         * blocked — it was written for a check that had never been implemented. **A comment is not
         * evidence.**
         *
         * ⚠️ Of every door here this is the one that most needed it. A blocked person could not
         * reach the user in a room, and could still reach them privately — which is the opposite way
         * round from what "blocking" means to the person who clicked it.
         *
         * Refused BEFORE unsealing, so a blocked sender does not even cost us the decryption; and
         * before `keep`, for the reason the channel door records — storing then hiding leaves a
         * blocked spammer paying nothing while we pay every cost of receiving.
         */
        const contact = yield* contacts.get(message.from)
        if (contact?.blocked === true) return { rejected: "blocked" as const }

        // ⚠️ The same pair the sender bound in. A re-signed envelope carries somebody else's `from`,
        // so the tag fails and this answers `unreadable` — which is the truth about it.
        const body = yield* identity.openSealed(message.sealed, { from: message.from, to: message.to })
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
        /**
         * 🔴 MOST RECENT FIRST. `selectDistinct` with no `ORDER BY` returns whatever order the
         * engine finds convenient, so the user's list of conversations could reorder itself between
         * two openings of the same screen with nothing having happened — the kind of thing a person
         * reads as the app losing their messages.
         *
         * ⚠️ Ordered by the newest RECEIVED time in each thread, not the author's claimed `at`:
         * sorting by a number the other party chooses would let them pin themselves to the top of
         * someone's list forever. That is the same rule `history` and the channel log follow, and
         * the reason it is stated again here is that this query had neither.
         */
        const rows = yield* db
          .select({ peer: CommunityDirectMessageTable.peer, at: sql<number>`max(received_at)` })
          .from(CommunityDirectMessageTable)
          .groupBy(CommunityDirectMessageTable.peer)
          .orderBy(desc(sql`max(received_at)`))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => row.peer)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, InstanceIdentityStore.node, CommunityContacts.node],
})
