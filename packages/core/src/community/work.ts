export * as CommunityWork from "./work"

import { createHash } from "node:crypto"
import type { CommunityMessage } from "./message"

/**
 * Community P5 — proof-of-work per message (`notes/spec/community-p2p.md`).
 *
 * 🔴 Built because the measurement demanded it. GossipSub's peer scoring, switched on, scored a
 * flooder at the CAP (1000) and the honest peer NEGATIVE, because `first_message_deliveries` rewards
 * volume and nothing punishes it — so the hardened answer does not address this attack at all. What
 * stops a flood is making each message COST something the sender cannot avoid.
 *
 * The asymmetry is the whole mechanism: finding a nonce takes many hashes, checking one takes a
 * single hash. A human posting occasionally pays a delay they never notice; a peer trying 9.8k
 * messages per second (the measured flood rate) would need ~9.8k × the solve cost per second, which
 * no ordinary machine has.
 *
 * ⚠️ **The work binds to the SIGNATURE, not to the message body.** That is deliberate: it means the
 * signed envelope does not change at all. A signature is already unique per message and unforgeable,
 * so work over it cannot be transplanted onto a different message, and a stripped or altered nonce
 * simply fails verification. Signing over a nonce instead would have forced the sender to solve
 * BEFORE signing and re-solve on every edit.
 */

/**
 * Leading zero BITS required. Chosen by measurement, not taste — see `work.test.ts`, which pins both
 * ends: a solve a human never notices, and a rate a flooder cannot sustain.
 */
export const DEFAULT_DIFFICULTY = 16

/** A cap so a hostile `difficulty` cannot be used to make a receiver burn CPU verifying nothing. */
export const MAX_DIFFICULTY = 32

const digest = (signature: string, nonce: number): Buffer =>
  createHash("sha256").update(`${signature}:${nonce}`).digest()

/** Leading zero bits of a digest — the standard difficulty measure. */
const leadingZeroBits = (hash: Buffer): number => {
  let bits = 0
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8
      continue
    }
    bits += Math.clz32(byte) - 24
    break
  }
  return bits
}

/**
 * Find a nonce whose digest clears `difficulty`.
 *
 * ⚠️ Bounded by `maxAttempts`. An unbounded loop is a hang on a machine that happens to be unlucky,
 * and a sender that cannot solve should report failure rather than freeze the UI — the difficulty is
 * a probability, not a promise.
 */
export const solve = (
  signature: string,
  difficulty: number = DEFAULT_DIFFICULTY,
  maxAttempts = 50_000_000,
): number | undefined => {
  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    if (leadingZeroBits(digest(signature, nonce)) >= difficulty) return nonce
  }
  return undefined
}

/**
 * Does this nonce prove the work? ONE hash, whatever the difficulty.
 *
 * That constant cost is what makes the mechanism survive contact with an attacker: a receiver spends
 * the same tiny amount rejecting a hostile message as accepting an honest one, so verification
 * itself can never become the flood.
 */
export const verify = (
  signature: string,
  nonce: number,
  difficulty: number = DEFAULT_DIFFICULTY,
): boolean => {
  if (!Number.isInteger(nonce) || nonce < 0) return false
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > MAX_DIFFICULTY) return false
  return leadingZeroBits(digest(signature, nonce)) >= difficulty
}

/**
 * Attach proof to a signed message — the one way to obtain a `Proven`.
 *
 * ⚠️ Generic over the message SHAPE, because the work binds to the signature and nothing else. It was
 * typed to the channel envelope until direct messages needed it too, and narrowing it there was an
 * accident of which caller came first rather than anything the mechanism requires.
 *
 * Returns `undefined` when the work could not be found inside `maxAttempts`, so a caller reports
 * failure rather than shipping a message the ingress door will refuse.
 */
export const prove = <T extends { readonly signature: string }>(
  message: T,
  difficulty: number = DEFAULT_DIFFICULTY,
): (T & { readonly nonce: number }) | undefined => {
  const nonce = solve(message.signature, difficulty)
  return nonce === undefined ? undefined : { ...message, nonce }
}
