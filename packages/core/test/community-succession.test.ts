import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P1 — key rotation (`todo/community-p2p.md`).
 *
 * A successor statement is the old key saying "the peer you knew as me is now this other key". What
 * these pin is that it proves exactly that and nothing more — and that it cannot be forged, replayed
 * into another protocol, or stapled onto by a stranger.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node])))

describe("CommunitySuccession", () => {
  it.effect("rotation mints a new identity and the OLD key vouches for it", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const before = yield* store.identity()

      const { identity: after, statement } = yield* store.rotate()
      expect(after.networkID).not.toBe(before.networkID)
      expect(statement.predecessor).toBe(before.networkID)
      expect(statement.successor).toBe(after.networkID)
      expect(CommunitySuccession.verify(statement)).toBe(true)

      // The instance now signs as the NEW key — rotation that left it signing as the old one would
      // be a statement about a change that never happened.
      const message = yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "after rotation" })
      expect(message.author).toBe(after.networkID)
      expect(CommunityMessage.verify(message)).toBe(true)

      // And the id a user's LAN already advertises is untouched: rotation changes the network
      // identity, not the install.
      expect(after.id).toBe(before.id)
    }),
  )

  it.effect("🔴 a peer follows the chain from the key it knew to the current one", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const original = (yield* store.identity()).networkID
      const first = yield* store.rotate()
      const second = yield* store.rotate()

      // Someone who met this instance long ago holds only `original`, and arrives at the current key
      // by following signatures — never by being told.
      expect(CommunitySuccession.resolve(original, [first.statement, second.statement])).toBe(
        second.identity.networkID,
      )
      // Order must not matter: statements arrive from a gossip mesh, not in sequence.
      expect(CommunitySuccession.resolve(original, [second.statement, first.statement])).toBe(
        second.identity.networkID,
      )
      // With the middle link missing, it stops at the last PROVEN key rather than guessing.
      expect(CommunitySuccession.resolve(original, [second.statement])).toBe(original)
    }),
  )

  it.effect("🔴 a stranger cannot staple their own statement onto a genuine chain", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const original = (yield* store.identity()).networkID
      const real = yield* store.rotate()

      // An attacker claims the identity moved on to a key of theirs. The claim is well-formed and
      // names the right predecessor — it is simply not signed by it.
      const hijack: CommunitySuccession.Statement = {
        predecessor: real.identity.networkID,
        successor: `nid_${Buffer.alloc(32, 9).toString("base64url")}`,
        at: Date.now(),
        signature: real.statement.signature,
      }
      expect(CommunitySuccession.verify(hijack)).toBe(false)
      // The chain therefore ends at the genuine successor, not the attacker's key.
      expect(CommunitySuccession.resolve(original, [real.statement, hijack])).toBe(real.identity.networkID)
    }),
  )

  it.effect("🔴 a succession cannot be replayed as a channel message, or the reverse", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const { statement } = yield* store.rotate()

      // Different domain tags mean the two signatures live in different worlds. Without that, bytes
      // signed to authorise a key handover could be replayed as something the peer "said".
      const asMessage = {
        channel: statement.predecessor,
        author: statement.predecessor,
        at: statement.at,
        body: statement.successor,
        signature: statement.signature,
      }
      expect(CommunityMessage.verify(asMessage)).toBe(false)
    }),
  )

  it.effect("garbage and self-succession are refused", () =>
    Effect.gen(function* () {
      const store = yield* InstanceIdentityStore.Service
      const { statement } = yield* store.rotate()

      /**
       * ⚠️ This case was VACUOUS on first writing: it edited `successor` on a real statement, which
       * breaks the signature, so `verify` refused it for that reason and the guard was never
       * reached — the test passed with the guard deleted. A self-succession has to be GENUINELY
       * SIGNED to test the rule, which is also the only form an attacker could send.
       */
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
      const self = `nid_${raw.toString("base64url")}`
      const body = { predecessor: self, successor: self, at: Date.now() }
      const selfish = {
        ...body,
        signature: nodeSign(null, Buffer.from(CommunitySuccession.canonicalBytes(body)), privateKey).toString(
          "base64url",
        ),
      }
      // Cryptographically perfect, and still refused: following it would record a rotation that
      // never happened while leaving the key unchanged.
      expect(CommunitySuccession.verify(selfish)).toBe(false)

      for (const broken of [
        { ...statement, signature: "" },
        { ...statement, signature: "!!!!" },
        { ...statement, successor: "alice" },
        { ...statement, at: Number.NaN },
      ])
        expect(CommunitySuccession.verify(broken)).toBe(false)
    }),
  )
})
