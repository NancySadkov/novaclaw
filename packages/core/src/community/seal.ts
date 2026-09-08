export * as CommunitySeal from "./seal"

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto"

/**
 * Community P3 — sealing a direct message.
 *
 * 🔴 Built because §11's argument DIED. It said a DM needs no encryption layer, because both
 * transport candidates encrypt end-to-end **to the peer's public key**, so even a relay "sees
 * ciphertext it cannot open". The shipped transport is HTTPS to an ADDRESS: TLS terminates at the
 * instance you connect to, relaying through instances is the answer for unreachable peers, and
 * `http://` routes carry no encryption at all. The exact case a relay exists to serve is the case a
 * third party holds the plaintext. Authenticity survived — messages are signed — but confidentiality
 * is the entire difference between a DM and a channel post, and it did not.
 *
 * ⚠️ **A SEPARATE X25519 key, never an Ed25519→X25519 conversion.** The conversion is the part §11
 * called "the most dangerous code in this whole program, the kind that looks finished long before it
 * is correct" — small-order points, cofactor handling, sign bits. `node:crypto` generates and agrees
 * on X25519 natively, so the identity key SIGNS a sealing key and nothing does curve arithmetic here.
 *
 * ⚠️ **Ephemeral sender key per message** (the age / sealed-box construction). A static-static
 * agreement would derive the same key for every message between two peers forever, so one recovered
 * key would open the entire history. The ephemeral secret is discarded before this function returns.
 *
 * ⚠️ What this does NOT give, stated so nobody assumes it: no protection if the RECIPIENT's long-term
 * key is later stolen (their key opens their backlog — the same property age has), no deniability,
 * and no metadata protection. The vision does not promise anonymity; the UI must say "only they can
 * read it", never "untraceable".
 */

/** Domain separation: bytes derived here must never be usable as any other key this program derives. */
const DOMAIN = "novaclaw/community/direct-message/1"
/** Its own tag, so the AAD can never be mistaken for the key-derivation info above. */
const AAD_DOMAIN = "novaclaw/community/direct-message-aad/1"

/** X25519 raw keys are 32 bytes; the DER wrappers `node:crypto` wants are fixed prefixes. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex")
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex")

export interface Envelope {
  /** The sender's throwaway public key for THIS message, base64url. */
  readonly epk: string
  /** AES-GCM initialisation vector, base64url. Fresh per message. */
  readonly iv: string
  /** Ciphertext ‖ auth tag, base64url. */
  readonly ct: string
}

export interface Keypair {
  /** Raw 32-byte public key, base64url — the half that gets published and signed. */
  readonly publicKey: string
  /** Raw 32-byte secret, base64url. Encrypted at rest by whoever stores it. */
  readonly secretKey: string
}

/** A fresh sealing keypair. Separate from the identity, and signed BY it when published. */
export const generate = (): Keypair => {
  const { publicKey, privateKey } = generateKeyPairSync("x25519")
  const publicRaw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(
    X25519_SPKI_PREFIX.length,
  )
  const secretRaw = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(
    X25519_PKCS8_PREFIX.length,
  )
  return { publicKey: publicRaw.toString("base64url"), secretKey: secretRaw.toString("base64url") }
}

/**
 * Parse a published sealing key. `undefined` rather than a throw: this arrives from a peer, so a
 * malformed one is untrusted input to reject, not an exception to unwind a request with.
 */
export const parsePublic = (encoded: string): KeyObject | undefined => {
  try {
    const raw = Buffer.from(encoded, "base64url")
    if (raw.length !== 32) return undefined
    return createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    })
  } catch {
    return undefined
  }
}

const parseSecret = (encoded: string): KeyObject | undefined => {
  try {
    const raw = Buffer.from(encoded, "base64url")
    if (raw.length !== 32) return undefined
    return createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    })
  } catch {
    return undefined
  }
}

/**
 * Derive the message key from an agreement.
 *
 * ⚠️ BOTH public keys go into the `info`, not just the shared secret. Without binding the derivation
 * to who the message is for, a ciphertext could be replayed toward a different recipient whose
 * agreement happened to produce the same bytes — and more practically, it is what makes the key
 * unique to this pair and this message rather than to the raw agreement alone.
 */
/**
 * 🔴 **The bytes that bind an envelope to its SENDER as well as its recipient** — review finding 1.8.
 *
 * The key derivation covers the recipient (`DOMAIN‖epk‖recipientPub`) and nothing about who sent it,
 * so ciphertext was portable between senders. Measured against the real stores: a third party copies
 * `(epk, iv, ct)` from an Alice→Bob message and signs a fresh envelope `{to: Bob, from: Carol}`. Bob
 * unseals it — the sealed bytes are still for him — and stores ALICE's plaintext in his conversation
 * with CAROL: `history(carol) = ["in: ALICE'S SECRET…"]`. Carol cannot read what she forwarded, but
 * a human or an agent replying to it quotes it straight back to her, and the property this feature
 * rests on — *what I read from C, C wrote* — is gone.
 *
 * ⚠️ Length-prefixed, like every other signed structure here: `from‖to` concatenated is ambiguous,
 * so one AAD would authenticate a pair it was never made for.
 *
 * ⚠️ AAD rather than folding the pair into the HKDF `info`. Both bind, and the trade is honest: the
 * derivation is the SENDER's to compute, while additional authenticated data is checked by GCM at
 * `final()` — so a mismatch reads as "this envelope is not for this conversation" rather than as
 * random plaintext, and `unseal` already answers `undefined` on that path.
 */
export const envelopeAAD = (from: string, to: string): Buffer => {
  const parts: Buffer[] = [Buffer.from(AAD_DOMAIN)]
  for (const value of [from, to]) {
    const bytes = Buffer.from(value, "utf8")
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length, 0)
    parts.push(length, bytes)
  }
  return Buffer.concat(parts)
}

const messageKey = (shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer =>
  Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([Buffer.from(DOMAIN), ephemeralPublic, recipientPublic]), 32),
  )

/**
 * Seal `plaintext` so ONLY the holder of `recipientPublicKey` can read it.
 *
 * Returns `undefined` for a key that does not parse — a peer that published nonsense is refused
 * rather than encrypted to badly.
 *
 * 🔴 …and for a key that PARSES and cannot be agreed with (review 2026-08-17, finding 1.12). An
 * all-zero or order-1 X25519 point decodes fine and carries a perfectly valid signature, and
 * `diffieHellman` then throws `ERR_CRYPTO_OPERATION_FAILED` — so publishing one made the SENDER's
 * own request 500 rather than refusing the recipient. A peer's key is untrusted input, and this
 * function's contract is that untrusted input produces `undefined`, never an exception in whatever
 * happened to be composing a message.
 */
export const seal = (
  recipientPublicKey: string,
  plaintext: string,
  /**
   * 🔴 Who this envelope is FROM and TO (finding 1.8). Without it the ciphertext is portable: a
   * third party can re-sign the same sealed bytes under their own name and have the recipient file
   * somebody else's words in a conversation with them.
   */
  aad: Buffer,
): Envelope | undefined => {
  const recipient = parsePublic(recipientPublicKey)
  if (recipient === undefined) return undefined

  // 🔴 Thrown away when this function returns, which is the forward secrecy: a sender whose key is
  // later recovered cannot reopen what they already sent.
  const ephemeral = generateKeyPairSync("x25519")
  const ephemeralPublic = (ephemeral.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(
    X25519_SPKI_PREFIX.length,
  )
  const recipientRaw = Buffer.from(recipientPublicKey, "base64url")

  let shared: Buffer
  try {
    shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
  } catch {
    // A small-order or otherwise degenerate point. Refusing is the same answer as an unparseable
    // key, because from the caller's side it is the same fact: this recipient cannot be sealed to.
    return undefined
  }
  const key = messageKey(shared, ephemeralPublic, recipientRaw)

  /**
   * 12 bytes, the standard GCM nonce size, from the CSPRNG.
   *
   * ⚠️ `randomBytes`, and it is worth saying why: the first draft took these bytes out of a freshly
   * generated X25519 public key, which is random enough to pass every test and is still wrong —
   * abusing a key generator as an RNG hides the intent and invites someone to "optimise" it into
   * something predictable. A repeated (key, iv) pair under GCM leaks the XOR of two plaintexts and
   * destroys authentication outright, so this is the one value that must obviously be random.
   */
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()])
  return {
    epk: ephemeralPublic.toString("base64url"),
    iv: iv.toString("base64url"),
    ct: Buffer.concat([body, cipher.getAuthTag()]).toString("base64url"),
  }
}

/**
 * Open a sealed envelope, or `undefined`.
 *
 * 🔴 EVERY failure returns `undefined` and none of them says why. A tampered ciphertext, a wrong
 * recipient, a truncated tag and a malformed key are indistinguishable to the caller on purpose:
 * distinguishing them is precisely what a padding-oracle attack needs, and "why did this fail" is
 * never information a sender is owed.
 */
export const unseal = (recipientSecretKey: string, envelope: Envelope, aad: Buffer): string | undefined => {
  try {
    const secret = parseSecret(recipientSecretKey)
    if (secret === undefined) return undefined
    const ephemeral = parsePublic(envelope.epk)
    if (ephemeral === undefined) return undefined

    const recipientRaw = (createPublicKey(secret).export({ type: "spki", format: "der" }) as Buffer).subarray(
      X25519_SPKI_PREFIX.length,
    )
    const shared = diffieHellman({ privateKey: secret, publicKey: ephemeral })
    const key = messageKey(shared, Buffer.from(envelope.epk, "base64url"), recipientRaw)

    const iv = Buffer.from(envelope.iv, "base64url")
    if (iv.length !== 12) return undefined
    const carried = Buffer.from(envelope.ct, "base64url")
    if (carried.length < 16) return undefined

    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    // ⚠️ Before the tag is set and `final()` runs: the AAD is part of what the tag authenticates, so
    // an envelope re-signed by somebody else fails here rather than opening into their conversation.
    decipher.setAAD(aad)
    // The tag is the last 16 bytes, and `final()` is what verifies it — a decrypt that skipped this
    // would return attacker-chosen plaintext and look like it worked.
    decipher.setAuthTag(carried.subarray(carried.length - 16))
    const opened = Buffer.concat([decipher.update(carried.subarray(0, carried.length - 16)), decipher.final()])
    return opened.toString("utf8")
  } catch {
    return undefined
  }
}
