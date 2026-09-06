import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommunitySeal } from "@novaclaw/core/community/seal"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P3 — sealing a direct message (`notes/spec/community-p2p.md`).
 *
 * 🔴 §11 argued a DM needs no encryption because the transport encrypted to the peer's KEY. The
 * shipped transport encrypts to an ADDRESS, so a relay — which is how unreachable peers are reached —
 * holds the plaintext. This is the layer that argument said we would not need.
 *
 * ⚠️ These lean on the NEGATIVE properties. A round-trip test passes against code that does nothing
 * at all interesting; what has to hold is that everyone except the recipient fails, and that every
 * failure looks identical.
 */

/**
 * The pair every envelope is bound to since review finding 1.8 — sender and recipient. These cases
 * are about the SEAL, so they all use one pair; the binding itself is exercised below.
 */
const PAIR_ENDS = { from: "nid_alice", to: "nid_bob" } as const
const PAIR = CommunitySeal.envelopeAAD(PAIR_ENDS.from, PAIR_ENDS.to)

describe("CommunitySeal", () => {
  test("a sealed message opens for its recipient, and for nobody else", () => {
    const alice = CommunitySeal.generate()
    const bob = CommunitySeal.generate()
    const eve = CommunitySeal.generate()

    const envelope = CommunitySeal.seal(bob.publicKey, "meet me at the usual place", PAIR)!
    expect(envelope).toBeDefined()

    expect(CommunitySeal.unseal(bob.secretKey, envelope, PAIR)).toBe("meet me at the usual place")
    // 🔴 The whole point. Eve holds a perfectly valid key of the right type and gets nothing.
    expect(CommunitySeal.unseal(eve.secretKey, envelope, PAIR)).toBeUndefined()
    // Not even the SENDER can reopen it: the ephemeral secret was discarded when `seal` returned,
    // which is the forward secrecy — a sender whose key is later recovered cannot reread their sent
    // messages, because the key that sealed them no longer exists anywhere.
    expect(CommunitySeal.unseal(alice.secretKey, envelope, PAIR)).toBeUndefined()
  })

  test("🔴 the ciphertext is never the plaintext, and never repeats", () => {
    const bob = CommunitySeal.generate()
    const secret = "the same words twice"
    const first = CommunitySeal.seal(bob.publicKey, secret, PAIR)!
    const second = CommunitySeal.seal(bob.publicKey, secret, PAIR)!

    // Sealing the same text twice must produce different bytes: a deterministic envelope tells an
    // observer that two messages are identical without opening either.
    expect(first.ct).not.toBe(second.ct)
    expect(first.iv).not.toBe(second.iv)
    expect(first.epk).not.toBe(second.epk)
    // And both still open.
    expect(CommunitySeal.unseal(bob.secretKey, first, PAIR)).toBe(secret)
    expect(CommunitySeal.unseal(bob.secretKey, second, PAIR)).toBe(secret)

    // The plaintext must not survive anywhere in the envelope.
    const wire = JSON.stringify(first)
    expect(wire).not.toContain(secret)
    expect(Buffer.from(first.ct, "base64url").toString("utf8")).not.toContain("same words")
  })

  test("🔴 ANY tampering is refused — the tag is verified, not decoration", () => {
    const bob = CommunitySeal.generate()
    const envelope = CommunitySeal.seal(bob.publicKey, "transfer approved", PAIR)!

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
      expect(CommunitySeal.unseal(bob.secretKey, broken, PAIR)).toBeUndefined()

    // Untouched, it still opens — so the refusals above are the tamper check firing, not a seal that
    // never worked.
    expect(CommunitySeal.unseal(bob.secretKey, envelope, PAIR)).toBe("transfer approved")
  })

  test("🔴 malformed keys are refused rather than thrown on — a peer is untrusted input", () => {
    const bob = CommunitySeal.generate()
    for (const bad of [
      "",
      "!!!!",
      "short",
      Buffer.alloc(31).toString("base64url"),
      Buffer.alloc(64).toString("base64url"),
    ]) {
      // Sealing TO nonsense must refuse rather than encrypt badly.
      expect(CommunitySeal.seal(bad, "hello", PAIR)).toBeUndefined()
      // Opening WITH nonsense must refuse rather than crash the request that carried it.
      expect(CommunitySeal.unseal(bad, CommunitySeal.seal(bob.publicKey, "hello", PAIR)!, PAIR)).toBeUndefined()
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
    expect(CommunitySeal.unseal(bob.secretKey, CommunitySeal.seal(bob.publicKey, "", PAIR)!, PAIR)).toBe("")
    const long = "🔴".repeat(20_000)
    expect(CommunitySeal.unseal(bob.secretKey, CommunitySeal.seal(bob.publicKey, long, PAIR)!, PAIR)).toBe(long)
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node])))

describe("the published sealing key", () => {
  it.effect("🔴 is SIGNED by the identity, so it cannot be substituted", () =>
    Effect.gen(function* () {
      /**
       * The attack this exists to stop is silent. A sealing key taken on trust is one anybody in the
       * path can swap for their own: the sender encrypts to the attacker, the attacker reads and
       * re-seals to the real recipient, and NOTHING looks wrong at either end — because a substituted
       * key produces perfectly valid ciphertext. The signature is the only thing that notices.
       */
      const store = yield* InstanceIdentityStore.Service
      const me = (yield* store.identity()).networkID
      const published = yield* store.sealingKey()

      expect(InstanceIdentityStore.verifySealingKey(me, published.publicKey, published.signature)).toBe(true)

      // An attacker's own key, offered in our name — the substitution, refused.
      const attacker = CommunitySeal.generate()
      expect(InstanceIdentityStore.verifySealingKey(me, attacker.publicKey, published.signature)).toBe(false)
      // Their key AND a signature they made with their own identity: still not ours to vouch for.
      const other = `nid_${Buffer.alloc(32, 3).toString("base64url")}`
      expect(InstanceIdentityStore.verifySealingKey(other, published.publicKey, published.signature)).toBe(false)

      for (const broken of ["", "!!!!", Buffer.alloc(63).toString("base64url")])
        expect(InstanceIdentityStore.verifySealingKey(me, published.publicKey, broken)).toBe(false)
    }).pipe(),
  )

  it.effect("🔴 is STABLE — a second call must not mint a second key", () =>
    Effect.gen(function* () {
      /**
       * ⚠️ The failure this pins is delayed and total: a peer fetches the key, seals to it, and the
       * message arrives addressed to a key this instance no longer holds. It would look like garbled
       * mail rather than like a bug in key minting, and only messages from BEFORE the last restart
       * would fail — which is the hardest possible thing to reproduce.
       */
      const store = yield* InstanceIdentityStore.Service
      const first = yield* store.sealingKey()
      const second = yield* store.sealingKey()
      expect(second.publicKey).toBe(first.publicKey)

      // And what was sealed to the published key really opens here — the round trip through storage,
      // not just through the pure module.
      const envelope = CommunitySeal.seal(first.publicKey, "for your eyes only", PAIR)!
      expect(yield* store.openSealed(envelope, PAIR_ENDS)).toBe("for your eyes only")

      // Something sealed to somebody else does not open, and does not throw.
      const stranger = CommunitySeal.generate()
      expect(
        yield* store.openSealed(CommunitySeal.seal(stranger.publicKey, "not for us", PAIR)!, PAIR_ENDS),
      ).toBeUndefined()
    }).pipe(),
  )
})

describe("a recipient key we cannot agree with is REFUSED, never thrown (finding 1.12)", () => {
  test("🔴 a small-order point parses, carries a valid signature, and seals to nothing", () => {
    /**
     * P2P review 2026-08-17: an all-zero or order-1 X25519 point decodes as a key perfectly well, so
     * `parsePublic` accepts it — and `diffieHellman` then throws `ERR_CRYPTO_OPERATION_FAILED`. The
     * throw landed in whoever was COMPOSING a direct message, so publishing such a key as your
     * sealing key made the SENDER's own request 500. A peer's key is untrusted input and this
     * module's contract is that untrusted input answers `undefined`.
     */
    for (const degenerate of [
      Buffer.alloc(32, 0),
      // Order 1 and order 2 points from RFC 7748 §6.1's small-subgroup list.
      Buffer.from("0100000000000000000000000000000000000000000000000000000000000000", "hex"),
      Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex"),
    ]) {
      const key = degenerate.toString("base64url")
      expect(() => CommunitySeal.seal(key, "hello", PAIR)).not.toThrow()
      expect(CommunitySeal.seal(key, "hello", PAIR)).toBeUndefined()
    }

    // The control: an honest key still seals, so this refuses the degenerate case and not the feature.
    const honest = CommunitySeal.generate()
    expect(CommunitySeal.seal(honest.publicKey, "hello", PAIR)).toBeDefined()
  })
})

/**
 * 🔴 P2P review 2026-08-17, finding 1.8 — **the seal bound the recipient but not the SENDER.**
 *
 * The key was derived from `DOMAIN‖epk‖recipientPub` and nothing about who sent it, so ciphertext
 * was portable between senders. Measured against the real stores: a third party copies `(epk, iv,
 * ct)` out of an Alice→Bob message and signs a fresh envelope `{to: Bob, from: Carol}`. Bob unseals
 * it — the bytes really are for him — and files ALICE's plaintext in his conversation with CAROL.
 * Carol cannot read what she forwarded, but a reply quoting it hands it straight to her, and the
 * property the whole feature rests on — *what I read from C, C wrote* — is gone.
 */
describe("an envelope is bound to its PAIR, not just its recipient (finding 1.8)", () => {
  test("🔴 re-signing somebody else's ciphertext under a new sender does not open", () => {
    const bob = CommunitySeal.generate()
    const alice = { networkID: "nid_alice" }
    const carol = { networkID: "nid_carol" }

    const envelope = CommunitySeal.seal(
      bob.publicKey,
      "ALICE'S SECRET: the meeting moved to Tuesday",
      CommunitySeal.envelopeAAD(alice.networkID, "nid_bob"),
    )!

    // Bob opens it as what it is: a message from Alice.
    expect(CommunitySeal.unseal(bob.secretKey, envelope, CommunitySeal.envelopeAAD(alice.networkID, "nid_bob"))).toBe(
      "ALICE'S SECRET: the meeting moved to Tuesday",
    )

    // Carol forwards the SAME sealed bytes under her own name. Before the AAD this opened, and Bob
    // stored Alice's words in his history with Carol.
    expect(
      CommunitySeal.unseal(bob.secretKey, envelope, CommunitySeal.envelopeAAD(carol.networkID, "nid_bob")),
      "a forwarded envelope must not open under a new sender",
    ).toBeUndefined()

    // …and the recipient half still binds too: the same envelope claimed to be for somebody else.
    expect(
      CommunitySeal.unseal(bob.secretKey, envelope, CommunitySeal.envelopeAAD(alice.networkID, "nid_carol")),
    ).toBeUndefined()
  })

  test("the AAD is unambiguous — two pairs cannot spell the same bytes", () => {
    // Length-prefixed, like every other signed structure here. Concatenated, `("ab","c")` and
    // `("a","bc")` are one string, and one AAD would authenticate a pair it was never made for.
    expect(CommunitySeal.envelopeAAD("ab", "c").equals(CommunitySeal.envelopeAAD("a", "bc"))).toBe(false)
  })
})
