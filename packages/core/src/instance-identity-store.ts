export * as InstanceIdentityStore from "./instance-identity-store"

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { eq, isNull, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { CredentialRepair } from "./credential/repair"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import * as Id from "./id/id"
import { CommunitySeal } from "./community/seal"
import { InstanceIdentityTable } from "./instance-identity/sql"

// Remote-access R7: the instance-wide durable identity. `get()` returns the stored id, minting
// one (`ins_…`) on first read — so every instance has a stable id from its first boot with no
// seed step. Advertised over mDNS and reported by /global/health so clients can recognize the
// SAME instance behind different URLs (mDNS name vs IP vs tunnel).
//
// Community P1 (`notes/spec/community-p2p.md`): that id is a random ULID, which is fine for recognising
// one install across routes and useless the moment a stranger makes the claim — anyone can say
// `ins_x`. So the instance also holds an **Ed25519 keypair**, minted on the same first read, and
// the PUBLIC KEY is its identity to the network. A URL is a route, the ULID is a handle, and only a
// signature is proof.

/** How a public key is written wherever a human or a peer might see one. */
const NETWORK_ID_PREFIX = "nid_"

/** Ed25519 raw key bytes sit inside a fixed DER prefix; slicing it off is exact, not a guess. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

const rawPublicKey = (der: Buffer): Buffer => der.subarray(SPKI_PREFIX.length)
const publicKeyFromRaw = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" })
const privateKeyFromRaw = (raw: Buffer) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" })

/** `nid_<base64url>` — the string form of a public key. */
export const networkID = (publicKey: Uint8Array): string =>
  `${NETWORK_ID_PREFIX}${Buffer.from(publicKey).toString("base64url")}`

/**
 * Parse a peer's `nid_…` back to raw key bytes, or `undefined` if it is not one.
 *
 * ⚠️ Length is checked, not assumed. `createPublicKey` on a short buffer throws inside whatever call
 * happens to be verifying, which reads as a crash rather than as "that peer sent us nonsense".
 *
 * 🔴 **CANONICAL ONLY, and that is the whole security property** (p2p review 2026-08-17, 1.2).
 * `Buffer.from(…, "base64url")` is lenient: it accepts the std alphabet, `=` padding, trailing
 * junk, interior whitespace, and low-bit variants of the final character — so ONE key had
 * unbounded spellings that all verified. Every guard downstream (`contacts.get`, the blocked flag,
 * the DM `peer` column, `answers.allowed`, the spend row, the dealing subject, the message PK)
 * compares the LITERAL string, so a blocked author simply re-spelled themselves and was stored.
 * Re-encoding and demanding the same string back makes a non-canonical author fail signature
 * verification at every door at once — a key is a key again, not a spelling.
 */
export const parseNetworkID = (value: string): Buffer | undefined => {
  if (!value.startsWith(NETWORK_ID_PREFIX)) return undefined
  const raw = Buffer.from(value.slice(NETWORK_ID_PREFIX.length), "base64url")
  if (raw.length !== 32 || networkID(raw) !== value) return undefined
  return raw
}

/** Verify a signature against a peer's network id. Never throws: a bad key is just `false`. */
export const verifySignature = (peer: string, message: Uint8Array, signature: Uint8Array): boolean => {
  const raw = parseNetworkID(peer)
  if (raw === undefined) return false
  try {
    return verify(null, Buffer.from(message), publicKeyFromRaw(raw), Buffer.from(signature))
  } catch {
    return false
  }
}

/**
 * A portable copy of the whole identity — **the secret included**.
 *
 * 🔴 THIS FILE IS THE INSTANCE. Anyone holding it can sign as this peer, in a network with no
 * authority to appeal to and no way to revoke. It is a backup in the same sense a house key is: the
 * point is to keep it, and keeping it badly is the risk.
 *
 * It exists because the alternative is worse. With no registry there is no password reset, so a dead
 * disk without a backup means the identity, its contacts and its history are gone permanently — the
 * "breaks in your hands" failure that `AGENTS.md` says a normal person must never meet.
 */
export interface Backup {
  /** Bumped only when the shape changes; a restore refuses a version it does not know. */
  readonly version: 1
  readonly id: string
  readonly networkID: string
  /** Raw 32-byte Ed25519 seed, base64url. */
  readonly secretKey: string
}

export class RestoreError extends Schema.TaggedErrorClass<RestoreError>()("InstanceIdentityStore.RestoreError", {
  message: Schema.String,
}) {}

/** Its own domain, so a succession can never be replayed as a channel message or the reverse. */
const SUCCESSION_DOMAIN = "novaclaw/community/succession/1"

/**
 * The bytes a successor statement is signed over.
 *
 * Lives HERE rather than beside the statement type purely to keep the dependency one-way:
 * `succession.ts` needs this module's key helpers to verify, so this module must not import it back.
 * Length-prefixed for the same reason as every other signed thing — two adjacent variable-length
 * fields concatenated are ambiguous, and one signature would attest to a statement never made.
 */
export const successionBytes = (input: {
  readonly predecessor: string
  readonly successor: string
  readonly at: number
}): Uint8Array => {
  const parts: Buffer[] = []
  const push = (value: string) => {
    const bytes = Buffer.from(value, "utf8")
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length, 0)
    parts.push(length, bytes)
  }
  push(SUCCESSION_DOMAIN)
  push(input.predecessor)
  push(input.successor)
  const at = Buffer.alloc(8)
  at.writeBigUInt64BE(BigInt(Math.trunc(input.at)), 0)
  parts.push(at)
  return Buffer.concat(parts)
}

/**
 * 🔴 **Proving that whoever answers an address HOLDS the key they name** — Codex review P1,
 * 2026-08-17.
 *
 * The identity probe returned a `networkID`, a sealing key and a static sealing-key signature, and
 * nothing in it was bound to the request. So the binding from a ROUTE to an IDENTITY was a string
 * claim anyone serving that path could make: a hostile endpoint replays a victim's published tuple,
 * and `identify`, `learnFrom`, `sendDirect` and `askPeer` all believe it. That is enough to become a
 * victim's preferred route (`reached` prepends it to the user's contact routes), to accept ciphertext
 * it cannot open and answer the uniform ack so `sendDirect` reports success, and — because a refusal
 * is unsigned and recorded as a first-hand dealing — to write false observations about somebody.
 *
 * The fix is a nonce the CALLER chooses. A signature over bytes the answerer could not predict is
 * possession; anything static is a quotation.
 *
 * ⚠️ Domain-separated and FIXED-LENGTH, so these bytes cannot be reinterpreted as any other signed
 * thing in this protocol: every other envelope begins with its own domain string, and a challenge is
 * exactly 32 bytes, so there is nothing to make ambiguous.
 */
const IDENTITY_PROOF_DOMAIN = "novaclaw/community/identity-proof/1"

/** How many bytes a challenge is. Fixed, so the signed message cannot be extended or shortened. */
export const CHALLENGE_BYTES = 32

/** The exact bytes an instance signs to prove it holds the key it named, or `undefined` for junk. */
export const identityProofBytes = (challenge: string): Uint8Array | undefined => {
  const raw = Buffer.from(challenge, "base64url")
  if (raw.length !== CHALLENGE_BYTES) return undefined
  return Buffer.concat([Buffer.from(IDENTITY_PROOF_DOMAIN), raw])
}

/**
 * Did the instance that answered really hold `networkID`?
 *
 * Total: a peer is untrusted bytes, and every malformed shape is `false` rather than a throw inside
 * whatever was probing.
 */
export const verifyIdentityProof = (networkID: string, challenge: string, proof: string | undefined): boolean => {
  if (typeof proof !== "string" || proof.length === 0) return false
  const bytes = identityProofBytes(challenge)
  if (bytes === undefined) return false
  const signature = Buffer.from(proof, "base64url")
  if (signature.length !== 64) return false
  return verifySignature(networkID, bytes, signature)
}

export interface Identity {
  /** The local handle, minted once (`ins_…`). What mDNS and /global/health already advertise. */
  readonly id: string
  /** The network identity: `nid_<base64url public key>`. */
  readonly networkID: string
  readonly publicKey: Buffer
}

/**
 * The exact bytes an instance signs to claim a sealing key.
 *
 * 🔴 Domain-separated, and this one matters more than most: without a prefix, a signature over a
 * 32-byte blob could be REPLAYED as a signature over something else 32 bytes long — a message hash, a
 * successor statement's key field — and a peer would accept an attacker's sealing key as the
 * identity's own. Which is exactly the substitution that would let them read the mail.
 */
export const sealingKeyBytes = (publicKey: string): Uint8Array =>
  Buffer.concat([Buffer.from("novaclaw/community/sealing-key/1"), Buffer.from(publicKey, "base64url")])

/**
 * Does this sealing key really belong to that identity?
 *
 * ⚠️ The whole point of publishing a signature beside the key. A sealing key taken on trust is a key
 * anyone in the path can substitute for their own, and the sender would encrypt to the attacker while
 * everything looked correct — the failure would be invisible precisely because it produces valid
 * ciphertext.
 */
export const verifySealingKey = (networkID: string, publicKey: string, signature: string): boolean => {
  if (typeof publicKey !== "string" || typeof signature !== "string") return false
  if (Buffer.from(publicKey, "base64url").length !== 32) return false
  const raw = Buffer.from(signature, "base64url")
  if (raw.length !== 64) return false
  return verifySignature(networkID, sealingKeyBytes(publicKey), raw)
}

export interface Interface {
  /** The instance's stable id — minted once on first read, immutable after. */
  readonly get: () => Effect.Effect<string>
  /** The full identity, minting the keypair on first read and backfilling an id that predates it. */
  readonly identity: () => Effect.Effect<Identity>
  /** Sign as this instance. The secret is read per call and never leaves this service. */
  readonly sign: (message: Uint8Array) => Effect.Effect<Buffer>
  /**
   * Export the identity INCLUDING its secret, for backup.
   *
   * ⚠️ Not agent-reachable. Whatever surfaces this must be a deliberate human action behind a
   * consent card — an agent that can call it can exfiltrate the instance.
   */
  readonly backup: () => Effect.Effect<Backup>
  /**
   * Restore a backup onto this instance.
   *
   * ⚠️ `replace` must be passed to overwrite an identity that already exists. Silently replacing one
   * would orphan every contact and channel that knows this peer, which is unrecoverable and looks
   * from the outside exactly like the instance being replaced by an impostor.
   */
  readonly restore: (backup: Backup, options?: { readonly replace?: boolean }) => Effect.Effect<Identity, RestoreError>
  /**
   * Rotate to a fresh keypair, returning the new identity and a statement the OLD key signed.
   *
   * 🔴 For PLANNED moves only. A thief holding the secret can rotate exactly as easily as the owner,
   * so this cannot recover a compromised key and must never be offered as if it could — recovery
   * needs contacts re-verifying out of band, which is a different feature with a human in it.
   */
  readonly rotate: () => Effect.Effect<{ readonly identity: Identity; readonly statement: SuccessorStatement }>
  /**
   * This instance's SEALING key and the identity's signature over it — the pair a peer needs to send
   * something only we can read.
   *
   * ⚠️ Public halves only. The signature is what makes the key usable by a stranger: without it they
   * would be trusting whatever key the network handed them, which is the substitution attack.
   */
  readonly sealingKey: () => Effect.Effect<{ readonly publicKey: string; readonly signature: string }>
  /**
   * Open something sealed to us, or `undefined`.
   *
   * ⚠️ The secret is read per call and never leaves this service, exactly like `sign`. A caller
   * that could obtain it could read every DM this instance will ever receive.
   */
  /**
   * ⚠️ Takes the PAIR the envelope claims, because the seal is bound to it (review 1.8). An
   * envelope re-signed by a third party names a different sender and therefore does not open.
   */
  readonly openSealed: (
    envelope: CommunitySeal.Envelope,
    pair: { readonly from: string; readonly to: string },
  ) => Effect.Effect<string | undefined>
}

/** What `rotate` hands back: BOTH keys' signatures over the handover. */
export interface SuccessorStatement {
  readonly predecessor: string
  readonly successor: string
  readonly at: number
  /** The retiring key's signature — "this new key is also me". */
  readonly signature: string
  /**
   * The new key's signature over the same bytes — "I accept that name" (review 1.4).
   *
   * ⚠️ Both, or a stranger can point a key they hold at a key they do not: a blocked attacker
   * issuing `attacker→victim` transferred their block onto the victim, and a fresh key could retire
   * ITSELF into a trusted contact and inherit that contact's record.
   */
  readonly successorSignature: string
}

/**
 * 🔴 **Every key this instance has ever held**, walked BACKWARD from the key it holds now.
 *
 * An instance is not its current key. A rotation replaces the key and keeps the person, and every
 * record written before it — a channel message's author, an observation's subject, an offer's sender
 * — still names the OLD one. So "is this us?" answered by `x === identity().networkID` answers a
 * narrower question than the one being asked: *is this our current spelling of us*. The first place
 * that mattered was the evidence packet, where it turned this user's own past posts into hearsay from
 * an unknown stranger on the one axis the system prompt tells the model to trust.
 *
 * ⚠️ **BACKWARD only, and that is what makes an unauthenticated store safe to read.** The succession
 * door accepts statements from anyone, so the table is stranger-writable by design. A backward step
 * from a key K accepts a statement only if its `successorSignature` verifies under K — and every K on
 * this walk is a key we hold or held, so every step demands a signature only we could have made. A
 * forward walk has no such property: it would follow whatever a stranger claims we became.
 *
 * ⚠️ BOTH signatures are checked, the same rule `succession.ts` states at its own door: the
 * predecessor says "this new key is also me" and the successor says "I accept that name", and one
 * alone lets a key be pointed at a key its author does not hold.
 *
 * ⚠️ A statement per predecessor is not assumed unique. A stranger can post rubbish naming one of our
 * keys as a successor, and taking the first row for a key would let that rubbish truncate our own
 * history — so every candidate is tried and the first that PROVES the handover wins.
 */
export const heldKeys = (current: string, statements: ReadonlyArray<SuccessorStatement>): ReadonlySet<string> => {
  const candidates = new Map<string, SuccessorStatement[]>()
  for (const statement of statements) {
    if (typeof statement.successor !== "string") continue
    const list = candidates.get(statement.successor)
    if (list === undefined) candidates.set(statement.successor, [statement])
    else list.push(statement)
  }
  const keys = new Set([current])
  let cursor = current
  for (;;) {
    const step = (candidates.get(cursor) ?? []).find(
      (statement) => !keys.has(statement.predecessor) && provenHandover(statement),
    )
    // A cycle is not merely useless — it is how a walk could be made to spin forever.
    if (step === undefined) return keys
    keys.add(step.predecessor)
    cursor = step.predecessor
  }
}

/** One handover, proven by both ends. Never throws: a malformed statement is simply not proof. */
const provenHandover = (statement: SuccessorStatement): boolean => {
  if (typeof statement.predecessor !== "string" || typeof statement.successor !== "string") return false
  // A statement naming itself as its own successor is nonsense that would otherwise verify.
  if (statement.predecessor === statement.successor) return false
  /**
   * ⚠️ `isSafeInteger`, not `isFinite` — the succession door's own lesson: a `BigInt(-1)` reaching
   * `writeBigUInt64BE` throws, and this reads rows a stranger can write.
   */
  if (!Number.isSafeInteger(statement.at) || statement.at < 0) return false
  if (typeof statement.signature !== "string" || typeof statement.successorSignature !== "string") return false
  const signature = Buffer.from(statement.signature, "base64url")
  const successorSignature = Buffer.from(statement.successorSignature, "base64url")
  if (signature.length !== 64 || successorSignature.length !== 64) return false
  const bytes = successionBytes(statement)
  return (
    verifySignature(statement.predecessor, bytes, signature) &&
    verifySignature(statement.successor, bytes, successorSignature)
  )
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/InstanceIdentityStore") {}

const SECRET_COLUMNS = ["secret_key", "sealing_secret_key"] as const

/** Secrets are canonical raw 32-byte keys, stored under the OS account's protection. */
const readSecret = (value: string): string => {
  const bytes = Buffer.from(value, "base64url")
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    throw new Error("Stored instance identity key is invalid. Restore an identity backup in Community settings.")
  return value
}

export const repairSource = (db: Database.Interface["db"]): CredentialRepair.ScanSource => ({
  name: "instance-identity",
  rows: () =>
    db
      .select()
      .from(InstanceIdentityTable)
      .pipe(
        Effect.map((rows) =>
          rows.flatMap((row) =>
            SECRET_COLUMNS.flatMap((column) =>
              row[column] == null ? [] : [{ path: `instance-identity:${column}`, value: row[column] }],
            ),
          ),
        ),
      ),
  validate: (_path, value) => Effect.try({ try: () => readSecret(String(value)), catch: (error) => error }),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const row = () => db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie)

    /**
     * Mint whatever is missing and return the row.
     *
     * ⚠️ Backfills, rather than assuming id and keypair arrive together: every instance that booted
     * before this change already has a row with an id and no keys, and a `get()` that only handled
     * the empty-table case would have left those instances permanently keyless.
     */
    const ensure = Effect.fn("InstanceIdentityStore.ensure")(function* () {
      const existing = yield* row()
      if (existing?.public_key && existing.secret_key) return existing

      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const publicRaw = rawPublicKey(publicKey.export({ type: "spki", format: "der" }) as Buffer)
      const secretRaw = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(PKCS8_PREFIX.length)
      const secret = secretRaw.toString("base64url")
      const publicEncoded = publicRaw.toString("base64url")

      if (existing === undefined) {
        const id = Id.create("ins", "ascending")
        // Two concurrent first reads race benignly: the second insert conflicts and the
        // stored winner is re-read — the id stays stable either way.
        yield* db
          .insert(InstanceIdentityTable)
          .values({ id, public_key: publicEncoded, secret_key: secret })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      } else {
        // 🔴 Guarded on the key still being absent, so a racing backfill cannot overwrite the
        // winner's key with the loser's. An instance whose public key changed under it would be a
        // DIFFERENT peer to everyone who had already met it.
        yield* db
          .update(InstanceIdentityTable)
          .set({ public_key: publicEncoded, secret_key: secret })
          .where(or(isNull(InstanceIdentityTable.public_key), isNull(InstanceIdentityTable.secret_key)))
          .run()
          .pipe(Effect.orDie)
      }
      const stored = yield* row()
      return stored ?? { id: "", public_key: publicEncoded, secret_key: secret }
    })

    const identity = Effect.fn("InstanceIdentityStore.identity")(function* () {
      const stored = yield* ensure()
      const publicKey = Buffer.from(stored.public_key ?? "", "base64url")
      return { id: stored.id, networkID: networkID(publicKey), publicKey }
    })

    return Service.of({
      get: Effect.fn("InstanceIdentityStore.get")(function* () {
        const stored = yield* ensure()
        return stored.id
      }),
      identity,
      /**
       * Mint the sealing keypair on first use and keep it thereafter.
       *
       * ⚠️ Lazy and separate from `ensure`, because every instance that existed before this change
       * has a row with an identity and no sealing key. Minting it inside `ensure` would have worked
       * only for instances created after it — the same backfill trap the identity keypair itself
       * already documents one function above.
       */
      sealingKey: Effect.fn("InstanceIdentityStore.sealingKey")(function* () {
        yield* ensure()
        // ⚠️ Re-read rather than trusting `ensure`'s return: it yields the freshly-inserted VALUES on
        // the mint path, which carry only the columns that insert set — the sealing pair reads as
        // absent there and would be minted a second time on the very next call.
        const stored = yield* row()
        let publicKey = stored?.sealing_public_key ?? undefined
        if (publicKey === undefined || !stored?.sealing_secret_key) {
          const minted = CommunitySeal.generate()
          yield* db
            .update(InstanceIdentityTable)
            .set({
              sealing_public_key: minted.publicKey,
              sealing_secret_key: minted.secretKey,
            })
            // 🔴 Guarded on absence, like the identity backfill: two concurrent first calls must not
            // let the loser overwrite the winner's key, or a peer that already fetched the first one
            // would be encrypting to a key nobody holds any more.
            .where(isNull(InstanceIdentityTable.sealing_public_key))
            .run()
            .pipe(Effect.orDie)
          publicKey = (yield* row())?.sealing_public_key ?? minted.publicKey
        }
        const secret = readSecret(stored?.secret_key ?? "")
        const signature = sign(
          null,
          Buffer.from(sealingKeyBytes(publicKey)),
          privateKeyFromRaw(Buffer.from(secret, "base64url")),
        )
        return { publicKey, signature: signature.toString("base64url") }
      }),

      openSealed: Effect.fn("InstanceIdentityStore.openSealed")(function* (
        envelope: CommunitySeal.Envelope,
        pair: { readonly from: string; readonly to: string },
      ) {
        const stored = yield* row()
        if (!stored?.sealing_secret_key) return undefined
        const secret = readSecret(stored.sealing_secret_key)
        return CommunitySeal.unseal(secret, envelope, CommunitySeal.envelopeAAD(pair.from, pair.to))
      }),

      sign: Effect.fn("InstanceIdentityStore.sign")(function* (message: Uint8Array) {
        const stored = yield* ensure()
        const secret = readSecret(stored.secret_key ?? "")
        return sign(null, Buffer.from(message), privateKeyFromRaw(Buffer.from(secret, "base64url")))
      }),
      rotate: Effect.fn("InstanceIdentityStore.rotate")(function* () {
        const stored = yield* ensure()
        const previousPublic = Buffer.from(stored.public_key ?? "", "base64url")
        const previousSecret = readSecret(stored.secret_key ?? "")

        const { publicKey, privateKey } = generateKeyPairSync("ed25519")
        const nextPublic = rawPublicKey(publicKey.export({ type: "spki", format: "der" }) as Buffer)
        const nextSecret = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(PKCS8_PREFIX.length)

        const statement = {
          predecessor: networkID(previousPublic),
          successor: networkID(nextPublic),
          at: Date.now(),
        }
        /**
         * ⚠️ Signed with the OLD key, and it has to be: the whole claim is "the peer you already
         * trust says this new key is also them". A statement signed by the NEW key alone would
         * prove nothing to anyone — the successor is a stranger until the predecessor vouches.
         */
        const bytes = Buffer.from(successionBytes(statement))
        const signature = sign(null, bytes, privateKeyFromRaw(Buffer.from(previousSecret, "base64url")))
        /**
         * 🔴 And with the NEW key too — review 2026-08-17, finding 1.4.
         *
         * One signature made the statement a claim about SOMEBODY ELSE's key that only the claimant
         * had to authorise, so a stranger could point a key they hold at one they do not: block
         * transfer, dossier smear, and a fresh key retiring itself INTO a trusted contact. Signing
         * both ends costs one extra `sign` on an operation that happens a handful of times in an
         * instance's life, and it is what makes the link a thing two parties agreed to.
         */
        const successorSignature = sign(null, bytes, privateKeyFromRaw(nextSecret))

        yield* db
          .update(InstanceIdentityTable)
          .set({
            public_key: nextPublic.toString("base64url"),
            secret_key: nextSecret.toString("base64url"),
          })
          .run()
          .pipe(Effect.orDie)

        return {
          identity: { id: stored.id, networkID: networkID(nextPublic), publicKey: nextPublic },
          statement: {
            ...statement,
            signature: signature.toString("base64url"),
            successorSignature: successorSignature.toString("base64url"),
          },
        }
      }),
      backup: Effect.fn("InstanceIdentityStore.backup")(function* () {
        const stored = yield* ensure()
        const secret = readSecret(stored.secret_key ?? "")
        const publicKey = Buffer.from(stored.public_key ?? "", "base64url")
        return { version: 1, id: stored.id, networkID: networkID(publicKey), secretKey: secret } satisfies Backup
      }),
      restore: Effect.fn("InstanceIdentityStore.restore")(function* (
        backup: Backup,
        options?: { readonly replace?: boolean },
      ) {
        if (backup.version !== 1)
          return yield* new RestoreError({
            message: `This backup is version ${backup.version}; this build reads version 1.`,
          })

        const secretRaw = Buffer.from(backup.secretKey ?? "", "base64url")
        if (secretRaw.length !== 32)
          return yield* new RestoreError({
            message: "The backup's secret key is not 32 bytes — it is truncated or not a NovaClaw backup.",
          })

        /**
         * 🔴 DERIVE the public key from the secret rather than trusting the file's own `networkID`.
         *
         * The two fields in a backup can disagree — through corruption, or because someone edited the
         * identity they claim while keeping a key they hold. Trusting the label would restore an
         * instance that signs with one key while announcing another: every signature it sends fails
         * verification, and the symptom is "peers ignore me", nowhere near the cause.
         */
        const derived = rawPublicKey(
          createPublicKey(privateKeyFromRaw(secretRaw)).export({ type: "spki", format: "der" }) as Buffer,
        )
        if (networkID(derived) !== backup.networkID)
          return yield* new RestoreError({
            message: "This backup's key does not match the identity it claims; it is corrupt or was edited.",
          })

        const existing = yield* row()
        if (existing?.public_key && options?.replace !== true)
          return yield* new RestoreError({
            message:
              "This instance already has an identity. Restoring would orphan every contact that knows it, so it must be confirmed explicitly.",
          })

        const secret = secretRaw.toString("base64url")
        const publicEncoded = derived.toString("base64url")
        if (existing === undefined)
          yield* db
            .insert(InstanceIdentityTable)
            .values({ id: backup.id, public_key: publicEncoded, secret_key: secret })
            .run()
            .pipe(Effect.orDie)
        else
          yield* db
            .update(InstanceIdentityTable)
            .set({ id: backup.id, public_key: publicEncoded, secret_key: secret })
            .run()
            .pipe(Effect.orDie)

        return { id: backup.id, networkID: backup.networkID, publicKey: derived }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
