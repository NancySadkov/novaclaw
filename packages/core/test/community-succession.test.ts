import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"
import { cosignedRotation, forgedRotation, mintIdentity } from "./lib/community"

/**
 * Community P1 — key rotation (`notes/spec/community-p2p.md`).
 *
 * A successor statement is the old key saying "the peer you knew as me is now this other key". What
 * these pin is that it proves exactly that and nothing more — and that it cannot be forged, replayed
 * into another protocol, or stapled onto by a stranger.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunitySuccession.node,
      // Finding 1.4 drives `contacts.follow` directly: the block-transfer attack is about what a
      // half-signed statement does to the ADDRESS BOOK, which no succession-only test can see.
      CommunityContacts.node,
    ]),
  ),
)

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
      expect(CommunitySuccession.resolve(original, [first.statement, second.statement])).toBe(second.identity.networkID)
      // Order must not matter: statements arrive from a gossip mesh, not in sequence.
      expect(CommunitySuccession.resolve(original, [second.statement, first.statement])).toBe(second.identity.networkID)
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
        successorSignature: real.statement.successorSignature,
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
      const me = mintIdentity()
      // Co-signed by construction — it is the same key on both ends, which is what makes this the
      // one forgery a self-succession does not even need a second party for.
      const selfish = cosignedRotation(me, me)
      // Cryptographically perfect, and still refused: following it would record a rotation that
      // never happened while leaving the key unchanged.
      expect(CommunitySuccession.verify(selfish)).toBe(false)

      for (const broken of [
        { ...statement, signature: "" },
        { ...statement, signature: "!!!!" },
        { ...statement, successorSignature: "" },
        { ...statement, successorSignature: "!!!!" },
        { ...statement, successor: "alice" },
        { ...statement, at: Number.NaN },
        /**
         * 🔴 The two that were a 500 ON THE WIRE, not merely a false (finding 1.12).
         * `successionBytes` writes `at` with `writeBigUInt64BE`, which THROWS out of range — and
         * `verify` only asked `Number.isFinite`. An anonymous `POST /api/community/succession` with
         * `at: -1` answered 500 UnknownError and wrote a full stack with absolute source paths into
         * the owner's log, free and unauthenticated, while a merely-bad signature answered 200.
         */
        { ...statement, at: -1 },
        { ...statement, at: Number.MAX_SAFE_INTEGER + 2 },
        { ...statement, at: 1.5 },
      ])
        expect(CommunitySuccession.verify(broken)).toBe(false)

      // ⚠️ And it must not THROW either: the door is anonymous, so a throw is a 500 and a stack in
      // the log. `verify` is total by contract and this is the case that proved it was not.
      expect(() => CommunitySuccession.verify({ ...statement, at: -1 })).not.toThrow()
    }),
  )
})

describe("the statement store is BOUNDED", () => {
  it.effect("🔴 a stranger cannot grow it for free", () =>
    Effect.gen(function* () {
      /**
       * The succession door is unauthenticated and carries no proof-of-work — a rotation is rare, and
       * charging for one would slow the honest case to deter a cheap attack. That leaves a store a
       * stranger can grow for nothing: generate a keypair, sign a statement retiring it to another key
       * you also generated, POST, repeat. Every one VERIFIES, because they really do own the key they
       * are retiring, and every one is a row.
       */
      const store = yield* CommunitySuccession.Store
      const mint = mintIdentity

      for (let index = 0; index < CommunitySuccession.MAX_STATEMENTS + 40; index++) {
        const from = mint()
        const to = mint()
        const statement = cosignedRotation(from, to)
        // Genuinely valid — this is not a forgery, which is exactly why a signature check cannot stop it.
        expect(CommunitySuccession.verify(statement)).toBe(true)
        yield* store.remember(statement)
      }

      expect((yield* store.known()).length).toBeLessThanOrEqual(CommunitySuccession.MAX_STATEMENTS)
    }),
  )
})

/**
 * 🔴 P2P review 2026-08-17, finding 1.4 — **a statement was signed by ONE side, so anyone could
 * point a key they hold at a key they do not.**
 *
 * The door is `anonymous` on the premise that "a statement is about the sender's OWN key" (spec
 * 2391–2393). Half true: it is equally about the SUCCESSOR's key, and nothing asked that side.
 * These are the three attacks the review ran against the real stores, each of which succeeded.
 */
describe("a succession needs BOTH keys (finding 1.4)", () => {
  it.effect("🔴 block transfer: a blocked attacker cannot hand their block to a stranger", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const attacker = mintIdentity()
      const victim = mintIdentity()

      yield* contacts.add({ networkID: attacker.networkID, petname: "attacker" })
      yield* contacts.setBlocked(attacker.networkID, true)

      /**
       * The victim is a stranger to this instance and has signed nothing. Before the co-signature,
       * `follow` accepted this: `contacts.get(victim)` came back `{petname:"attacker",
       * blocked:true}`, the victim's next signed post was rejected as blocked, and the address book
       * listed the VICTIM's key as "attacker (blocked, 1 former key)".
       */
      const forged = forgedRotation(attacker, victim.networkID)
      expect(CommunitySuccession.verify(forged)).toBe(false)
      expect(yield* contacts.follow(forged)).toBe(false)
      expect(yield* contacts.get(victim.networkID)).toBeUndefined()
      expect((yield* contacts.get(attacker.networkID))?.blocked).toBe(true)

      // The control: with the victim's own signature it IS a rotation, and behaves like one. A guard
      // that refused every statement would pass every line above and break rotation entirely.
      const real = cosignedRotation(attacker, victim)
      expect(CommunitySuccession.verify(real)).toBe(true)
      expect(yield* contacts.follow(real)).toBe(true)
      expect((yield* contacts.get(attacker.networkID))?.networkID).toBe(victim.networkID)
    }),
  )

  it.effect("🔴 reverse laundering: a fresh key cannot retire ITSELF into a trusted contact", () =>
    Effect.gen(function* () {
      const successions = yield* CommunitySuccession.Store
      const wolf = mintIdentity()
      const trusted = mintIdentity()

      /**
       * The other direction, and the one `follow` alone did not close: rather than pushing their
       * name onto a stranger, the attacker retires a key they just minted INTO somebody with a
       * record — inheriting the standing that key earned. `remember` accepted it, so `about(wolf)`
       * answered with the doorman's dealings.
       */
      const laundering = forgedRotation(wolf, trusted.networkID)
      expect(CommunitySuccession.verify(laundering)).toBe(false)
      expect(yield* successions.remember(laundering)).toBe(false)
      expect(yield* successions.known()).toEqual([])
    }),
  )

  it.effect("🔴 the chain will not walk through a half-signed link", () =>
    Effect.gen(function* () {
      const first = mintIdentity()
      const second = mintIdentity()
      const stolen = mintIdentity()

      // A genuine first hop, then a forged second one stapled on — the shape that captures an
      // identity by extending somebody else's chain.
      const genuine = cosignedRotation(first, second)
      const stapled = forgedRotation(second, stolen.networkID)
      expect(CommunitySuccession.resolve(first.networkID, [genuine, stapled])).toBe(second.networkID)
    }),
  )
})
