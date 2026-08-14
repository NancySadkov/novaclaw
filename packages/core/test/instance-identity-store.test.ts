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

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node])))

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
      expect(
        InstanceIdentityStore.verifySignature(identity.networkID, message, yield* store.sign(message)),
      ).toBe(true)
    }),
  )

  it.effect("🔴 the secret is stored as CIPHERTEXT — a readable key is an impersonation kit", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const identity = yield* store.identity()
      const { db } = yield* Database.Service
      const row = yield* db.select().from(InstanceIdentityTable).get()

      expect(row?.secret_key).toStartWith("nc1:")
      // The public half is in the clear on purpose; the secret must not be recoverable from the row.
      expect(row?.public_key).toBe(identity.publicKey.toString("base64url"))
      expect(row?.secret_key).not.toContain(identity.publicKey.toString("base64url"))
    }),
  )
})
