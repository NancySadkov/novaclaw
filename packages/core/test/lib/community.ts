import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { CommunitySuccession } from "@novaclaw/core/community/succession"

/**
 * Fixtures for the community's signed envelopes.
 *
 * 🔴 Shared because a succession statement now needs BOTH keys (review 2026-08-17, finding 1.4), and
 * five test files were each building one by hand from the predecessor alone. A per-file fixture is
 * how a protocol change turns into five subtly different protocols — the same argument
 * `succession.ts` makes for having ONE encoder.
 */

/** A fresh identity nobody has met, plus the ability to sign as it. */
export const mintIdentity = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  return { networkID: `nid_${raw.toString("base64url")}`, privateKey }
}

export type MintedIdentity = ReturnType<typeof mintIdentity>

const signAs = (identity: MintedIdentity, bytes: Uint8Array) =>
  nodeSign(null, Buffer.from(bytes), identity.privateKey).toString("base64url")

/**
 * `from` saying it is now `to`, **and `to` accepting** — the only form that verifies.
 *
 * ⚠️ Both halves are genuine. A fixture that signed only the predecessor half would be building the
 * exact forgery finding 1.4 describes, and every test using it would then be asserting that
 * forgeries work.
 */
export const cosignedRotation = (
  from: MintedIdentity,
  to: MintedIdentity,
  at = Date.now(),
): CommunitySuccession.Statement => {
  const body = { predecessor: from.networkID, successor: to.networkID, at }
  const bytes = CommunitySuccession.canonicalBytes(body)
  return { ...body, signature: signAs(from, bytes), successorSignature: signAs(to, bytes) }
}

/**
 * A statement signed by the PREDECESSOR only — what every attack in finding 1.4 sends.
 *
 * Kept here rather than written out per test so the negative cases all send the same shape: the
 * successor half is a valid-length signature over the right bytes by the WRONG key, which is the
 * strongest forgery available to someone who does not hold the successor's secret.
 */
export const forgedRotation = (
  from: MintedIdentity,
  successor: string,
  at = Date.now(),
): CommunitySuccession.Statement => {
  const body = { predecessor: from.networkID, successor, at }
  const bytes = CommunitySuccession.canonicalBytes(body)
  return { ...body, signature: signAs(from, bytes), successorSignature: signAs(from, bytes) }
}
