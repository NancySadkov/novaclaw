import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { InstanceIdentityTable } from "@novaclaw/core/instance-identity/sql"
import { testEffect } from "./lib/effect"

/**
 * Community P1 — the instance's cryptographic identity (`todo/community-p2p.md`).
 *
 * What these pin is the difference between a NAME and a PROOF. The `ins_…` id says who an instance
 * claims to be, and any stranger can claim the same string; only a signature settles it. The rest
 * guards the two ways that guarantee dies later: a key that changes makes the instance a different
 * peer to everyone who already met it, and a key an agent can read is not its key any more.
 *
 * ⚠️ Each case does its reads inside ONE `it.effect`. Split across two runtimes they would run
 * against two different in-memory databases, and the stability assertion would be comparing an
 * identity to itself in a fresh world — passing while proving nothing.
 */

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node, CredentialCipher.node])),
)

describe("InstanceIdentityStore", () => {
  it.effect("mints a keypair on first read, with no seed step", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const identity = yield* store.identity()
      expect(identity.id).toStartWith("ins_")
      expect(identity.networkID).toStartWith("nid_")
      expect(identity.publicKey).toHaveLength(32)

      // Stable across reads: a rotating identity is a different peer every time.
      expect((yield* store.identity()).networkID).toBe(identity.networkID)
      expect(yield* store.get()).toBe(identity.id)
    }),
  )

  it.effect("a signature verifies against the network id — that is the whole point", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const identity = yield* store.identity()
      const message = new TextEncoder().encode("channel:#NovaClaw|hello")
      const signature = yield* store.sign(message)
      expect(InstanceIdentityStore.verifySignature(identity.networkID, message, signature)).toBe(true)

      // 🔴 A different message must NOT verify, or a signature endorses anything.
      const tampered = new TextEncoder().encode("channel:#NovaClaw|hellp")
      expect(InstanceIdentityStore.verifySignature(identity.networkID, tampered, signature)).toBe(false)

      // 🔴 Nor may a stranger's id verify our signature — impersonation is the threat this exists for.
      const stranger = `nid_${Buffer.alloc(32, 7).toString("base64url")}`
      expect(InstanceIdentityStore.verifySignature(stranger, message, signature)).toBe(false)
    }),
  )

  it.effect("hostile nonsense returns false rather than throwing", () =>
    Effect.gen(function* () {
      const signature = Buffer.alloc(64)
      const message = new TextEncoder().encode("x")
      // A peer is an untrusted source of strings; a reader that throws on a malformed id turns
      // "that peer sent rubbish" into a crash in whatever was verifying.
      for (const peer of ["", "nid_", "not-an-id", "nid_!!!!", `nid_${Buffer.alloc(8).toString("base64url")}`])
        expect(InstanceIdentityStore.verifySignature(peer, message, signature)).toBe(false)
    }),
  )

  it.effect("🔴 an instance that predates the keypair is BACKFILLED, not left keyless", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // Exactly the row shape every instance that booted before this change has on disk.
      yield* db.delete(InstanceIdentityTable).run()
      yield* db.insert(InstanceIdentityTable).values({ id: "ins_legacy" }).run()

      const store = yield* InstanceIdentityStore.Service
      const identity = yield* store.identity()
      expect(identity.publicKey).toHaveLength(32)
      // The existing id SURVIVES: mDNS and /global/health already advertise it, so replacing it
      // would break the cross-route dedup those consumers do today.
      expect(identity.id).toBe("ins_legacy")

      const message = new TextEncoder().encode("after backfill")
      expect(InstanceIdentityStore.verifySignature(identity.networkID, message, yield* store.sign(message))).toBe(true)
    }),
  )

  it.effect("a backup round-trips onto a fresh instance — the disk-died case", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const original = yield* store.identity()
      const backup = yield* store.backup()
      const message = new TextEncoder().encode("signed before the disk died")

      // A fresh instance: no row at all, exactly as after a reinstall.
      const { db } = yield* Database.Service
      yield* db.delete(InstanceIdentityTable).run()

      const restored = yield* store.restore(backup)
      expect(restored.networkID).toBe(original.networkID)
      // The restored instance signs as the SAME peer — which is the entire point of a backup in a
      // network where nobody can vouch for you.
      expect(InstanceIdentityStore.verifySignature(original.networkID, message, yield* store.sign(message))).toBe(true)
    }),
  )

  it.effect("🔴 restoring over a live identity needs `replace` — silence would orphan every contact", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      yield* store.identity()
      // A VALID backup, so this isolates the replace guard rather than tripping the key checks
      // first — the earlier version of this test used a garbage key and was really re-testing
      // validation while claiming to test the guard.
      const valid = yield* store.backup()

      const refused = yield* store.restore(valid).pipe(Effect.flip)
      expect(refused.message).toContain("already has an identity")

      // And the other half: with the confirmation it goes through, or the guard is a permanent
      // lock rather than a "are you sure".
      const replaced = yield* store.restore(valid, { replace: true })
      expect(replaced.networkID).toBe(valid.networkID)
    }),
  )

  it.effect("🔴 a backup whose key does not match its claimed id is REFUSED", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const real = yield* store.backup()
      const { db } = yield* Database.Service
      yield* db.delete(InstanceIdentityTable).run()

      // Same real secret, but the file claims a different identity. Trusting the label would
      // restore an instance that SIGNS with one key and ANNOUNCES another: every signature it sends
      // fails verification, and the symptom ("peers ignore me") is nowhere near the cause.
      const lying = { ...real, networkID: `nid_${Buffer.alloc(32, 5).toString("base64url")}` }
      const refused = yield* store.restore(lying).pipe(Effect.flip)
      expect(refused.message).toContain("does not match")

      const truncated = { ...real, secretKey: Buffer.alloc(8).toString("base64url") }
      expect((yield* store.restore(truncated).pipe(Effect.flip)).message).toContain("32 bytes")

      const future = { ...real, version: 2 as unknown as 1 }
      expect((yield* store.restore(future).pipe(Effect.flip)).message).toContain("version 1")
    }),
  )

  /**
   * 🔴 This asserted CIPHERTEXT until 2026-08-28, under the name "a readable key is an
   * impersonation kit". The claim deserves an answer rather than a silent inversion.
   *
   * It is true that a readable identity secret is an impersonation kit. It was equally true with
   * the encryption in place: the key that opens this column lived in `credential.key` beside the
   * database, readable by the same account that reads the row. Anything able to steal the row could
   * take the key in the same breath, so the ciphertext bought a step, not a boundary.
   *
   * Decision §5 of `decisions-v0.2.0.md` faces this directly and accepts it out loud — "secrets stay
   * readable by anything running as the user, permanently, and we say so" — which is what makes the
   * permission, jail and egress work load-bearing rather than optional.
   *
   * ⚠️ One narrow protection IS given up, and it should be named rather than glossed: a backup that
   * copied the database but not the state directory used to leak ciphertext without its key. That is
   * the very same mechanism as NC-REL-030 seen from the other side — the copy that could not be read
   * by an attacker was equally unreadable by its owner, and bricked the instance it was restored to.
   */
  it.effect("the identity secret is stored in the clear, and the public half still matches", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const identity = yield* store.identity()
      const { db } = yield* Database.Service
      const row = yield* db.select().from(InstanceIdentityTable).get()

      expect(row?.secret_key).not.toStartWith("nc1:")
      // A raw Ed25519 seed, base64url, as `backup()` exports it — not an envelope.
      expect(Buffer.from(row?.secret_key ?? "", "base64url")).toHaveLength(32)
      expect(row?.secret_key).toBe((yield* store.backup()).secretKey)
      expect(row?.public_key).toBe(identity.publicKey.toString("base64url"))
    }),
  )

  /**
   * 🔴 The property that makes this safe to change AT ALL, and the reason it landed with the write
   * change rather than after it.
   *
   * These are the one set of secrets a user cannot re-enter. A provider credential can be pasted
   * again and an OAuth flow rerun; an Ed25519 identity that will not open is a network identity
   * permanently lost, along with every contact's record of it. So the read accepts BOTH forms: a row
   * written before this change still opens, and a row written after it reads directly. No row can be
   * orphaned by which form it happens to be in.
   *
   * A/B: make `openSecret` return the value unconditionally and this fails; make it decrypt
   * unconditionally and the test above fails.
   */
  it.effect("🔴 an identity encrypted by an OLDER build still opens", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const cipher = yield* CredentialCipher.Service
      const { db } = yield* Database.Service
      const identity = yield* store.identity()
      const plaintextSecret = (yield* store.backup()).secretKey
      const signedBefore = yield* store.sign(new TextEncoder().encode("a message"))

      // Put the row back into the shape the previous build wrote, using the instance's own cipher —
      // encrypting under any other key would exercise a failure path and pass for the wrong reason.
      yield* db
        .update(InstanceIdentityTable)
        .set({ secret_key: cipher.encrypt(plaintextSecret, "instance-identity.secret_key") })
        .run()

      // Still the same identity, and still SIGNING with the same key — which is the property that
      // actually matters: a store that read the envelope as if it were a seed would produce a
      // different key and every signature would silently stop verifying.
      const reopened = yield* store.identity()
      expect(reopened.publicKey.toString("base64url")).toBe(identity.publicKey.toString("base64url"))
      expect((yield* store.backup()).secretKey).toBe(plaintextSecret)
      expect((yield* store.sign(new TextEncoder().encode("a message"))).toString("base64url")).toBe(
        signedBefore.toString("base64url"),
      )
    }),
  )
})
