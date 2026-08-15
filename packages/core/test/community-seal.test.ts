import { describe, expect, test } from "bun:test"
import { CommunitySeal } from "@novaclaw/core/community/seal"

/**
 * Community P3 — sealing a direct message (`todo/community-p2p.md`).
 *
 * 🔴 §11 argued a DM needs no encryption because the transport encrypted to the peer's KEY. The
 * shipped transport encrypts to an ADDRESS, so a relay — which is how unreachable peers are reached —
 * holds the plaintext. This is the layer that argument said we would not need.
 *
 * ⚠️ These lean on the NEGATIVE properties. A round-trip test passes against code that does nothing
 * at all interesting; what has to hold is that everyone except the recipient fails, and that every
 * failure looks identical.
 */

describe("CommunitySeal", () => {
  test("a sealed message opens for its recipient, and for nobody else", () => {
    const alice = CommunitySeal.generate()
    const bob = CommunitySeal.generate()
    const eve = CommunitySeal.generate()

    const envelope = CommunitySeal.seal(bob.publicKey, "meet me at the usual place")!
    expect(envelope).toBeDefined()

    expect(CommunitySeal.unseal(bob.secretKey, envelope)).toBe("meet me at the usual place")
    // 🔴 The whole point. Eve holds a perfectly valid key of the right type and gets nothing.
    expect(CommunitySeal.unseal(eve.secretKey, envelope)).toBeUndefined()
    // Not even the SENDER can reopen it: the ephemeral secret was discarded when `seal` returned,
    // which is the forward secrecy — a sender whose key is later recovered cannot reread their sent
    // messages, because the key that sealed them no longer exists anywhere.
    expect(CommunitySeal.unseal(alice.secretKey, envelope)).toBeUndefined()
  })

  test("🔴 the ciphertext is never the plaintext, and never repeats", () => {
    const bob = CommunitySeal.generate()
    const secret = "the same words twice"
    const first = CommunitySeal.seal(bob.publicKey, secret)!
    const second = CommunitySeal.seal(bob.publicKey, secret)!

    // Sealing the same text twice must produce different bytes: a deterministic envelope tells an
    // observer that two messages are identical without opening either.
    expect(first.ct).not.toBe(second.ct)
    expect(first.iv).not.toBe(second.iv)
    expect(first.epk).not.toBe(second.epk)
    // And both still open.
    expect(CommunitySeal.unseal(bob.secretKey, first)).toBe(secret)
    expect(CommunitySeal.unseal(bob.secretKey, second)).toBe(secret)

    // The plaintext must not survive anywhere in the envelope.
    const wire = JSON.stringify(first)
    expect(wire).not.toContain(secret)
    expect(Buffer.from(first.ct, "base64url").toString("utf8")).not.toContain("same words")
  })

  test("🔴 ANY tampering is refused — the tag is verified, not decoration", () => {
    const bob = CommunitySeal.generate()
    const envelope = CommunitySeal.seal(bob.publicKey, "transfer approved")!

    const flip = (value: string) => {
      const raw = Buffer.from(value, "base64url")
      raw[0] = raw[0]! ^ 0x01
      return raw.toString("base64url")
    }

    // Every field, one bit each. A decrypt that skipped `final()` would return attacker-chosen
    // plaintext for the first of these and look like it worked.
    for (const broken of [
      { ...envelope, ct: flip(envelope.ct) },
      { ...envelope, iv: flip(envelope.iv) },
      { ...envelope, epk: flip(envelope.epk) },
      // Truncating the tag: the last 16 bytes ARE the authentication.
      { ...envelope, ct: Buffer.from(envelope.ct, "base64url").subarray(0, 8).toString("base64url") },
      { ...envelope, ct: "", iv: "", epk: "" },
    ])
      expect(CommunitySeal.unseal(bob.secretKey, broken)).toBeUndefined()

    // Untouched, it still opens — so the refusals above are the tamper check firing, not a seal that
    // never worked.
    expect(CommunitySeal.unseal(bob.secretKey, envelope)).toBe("transfer approved")
  })

  test("🔴 malformed keys are refused rather than thrown on — a peer is untrusted input", () => {
    const bob = CommunitySeal.generate()
    for (const bad of ["", "!!!!", "short", Buffer.alloc(31).toString("base64url"), Buffer.alloc(64).toString("base64url")]) {
      // Sealing TO nonsense must refuse rather than encrypt badly.
      expect(CommunitySeal.seal(bad, "hello")).toBeUndefined()
      // Opening WITH nonsense must refuse rather than crash the request that carried it.
      expect(CommunitySeal.unseal(bad, CommunitySeal.seal(bob.publicKey, "hello")!)).toBeUndefined()
    }
    expect(CommunitySeal.parsePublic(bob.publicKey)).toBeDefined()
    expect(CommunitySeal.parsePublic("not-a-key")).toBeUndefined()
  })

  test("keys are the right shape, and every generation differs", () => {
    const first = CommunitySeal.generate()
    const second = CommunitySeal.generate()
    for (const key of [first.publicKey, first.secretKey, second.publicKey, second.secretKey])
      expect(Buffer.from(key, "base64url")).toHaveLength(32)
    expect(first.publicKey).not.toBe(second.publicKey)
    expect(first.secretKey).not.toBe(second.secretKey)
    // ⚠️ The secret must never equal the public half — a swap in `generate` would produce a working
    // round trip while publishing the secret, and the round-trip test alone would not notice.
    expect(first.secretKey).not.toBe(first.publicKey)
  })

  test("survives an empty body and a large one", () => {
    const bob = CommunitySeal.generate()
    expect(CommunitySeal.unseal(bob.secretKey, CommunitySeal.seal(bob.publicKey, "")!)).toBe("")
    const long = "🔴".repeat(20_000)
    expect(CommunitySeal.unseal(bob.secretKey, CommunitySeal.seal(bob.publicKey, long)!)).toBe(long)
  })
})
