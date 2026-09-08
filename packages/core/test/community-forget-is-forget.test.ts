import { describe, expect } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { Database } from "@novaclaw/core/database/database"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"
import { cosignedRotation, mintIdentity } from "./lib/community"

/**
 * 🔴 **§5(k) of `notes/spec/honesty-ledger.md`: a dossier, not a log.**
 *
 * *"✗ Fails if `forget` leaves a score behind."* There is no score column by design, but the
 * observations ARE the dossier — what a peer promised, what they delivered, and the agent's own
 * prose about them. A `forget` that removes the address book entry and keeps the notes has not
 * forgotten anybody; it has only stopped being able to write to them.
 *
 * ⚠️ The spec leaves two things open on purpose — whether a forgotten peer's history returns if they
 * are re-added, and whether anything is kept in aggregate — but it is explicit that **the default
 * must be that forget means forget, because the opposite is unrecoverable once shipped.**
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityContacts.node,
      CommunityPeers.node,
      CommunitySuccession.node,
      CommunityObservation.node,
    ]),
  ),
)

const stranger = () => {
  const { publicKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  return `nid_${raw.toString("base64url")}`
}

describe("forget means forget", () => {
  it.effect("🔴 the DEALINGS go with the contact, not just the address", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const peers = yield* CommunityPeers.Service
      const ledger = yield* CommunityObservation.Service
      const peer = stranger()

      yield* peers.learn(peer, ["http://127.0.0.1:4"], "lan")
      yield* contacts.add({ networkID: peer, petname: "someone", routes: ["http://127.0.0.1:4"] })
      yield* ledger.recordFirstHand({ subject: peer, at: 1_000, context: "asked", outcome: "answered" })
      yield* ledger.recordFirstHand({ subject: peer, at: 2_000, context: "asked", outcome: "refused" })

      expect((yield* ledger.about(peer)).length, "the fixture must have written something to forget").toBe(2)

      const forgotten = yield* contacts.forget(peer)
      expect(forgotten).toBe(true)

      /**
       * 🔴 The assertion. A user who clicks Forget is not asking for the address to be dropped while
       * the instance keeps its file on the person — that is the opposite of what the word means, and
       * `AGENTS.md` puts the user above the ledger in every other respect.
       */
      expect(yield* ledger.about(peer), "forgetting a peer must take the dossier with it").toEqual([])
    }),
  )

  it.effect("⚠️ and the control: an untouched peer's dealings SURVIVE", () =>
    Effect.gen(function* () {
      /**
       * Without this, a `forget` that wiped the whole table — or an `about()` that always answered
       * empty — would pass the test above while destroying everybody's history.
       */
      const contacts = yield* CommunityContacts.Service
      const ledger = yield* CommunityObservation.Service
      const kept = stranger()
      const dropped = stranger()

      for (const peer of [kept, dropped]) {
        yield* contacts.add({ networkID: peer, routes: ["http://127.0.0.1:4"] })
        yield* ledger.recordFirstHand({ subject: peer, at: 1_000, context: "asked", outcome: "answered" })
      }

      yield* contacts.forget(dropped)
      expect((yield* ledger.about(kept)).length, "forgetting one peer must not touch another's").toBe(1)
    }),
  )
})

/**
 * 🔴 P2P review 2026-08-17, finding 1.17 — **`forget` left the person behind in three places.**
 *
 * Measured against the real stores: two succession rows survived after forgetting `a→b→c` and were
 * re-served on `GET /api/community/succession`; observations attached to a key linked only through
 * that table survived, so `about(B)` still returned the file; and a peer who was never a contact had
 * no deletion path at all — `forget(C)` returned false and did nothing. The consent screen's
 * "Forgetting someone deletes theirs" was true only of people the user had first ADDED.
 */
describe("forget reaches every store that remembers them (1.17)", () => {
  it.effect("🔴 the succession chain goes too — we stop publishing their key history", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const successions = yield* CommunitySuccession.Store
      const first = mintIdentity()
      const second = mintIdentity()
      const third = mintIdentity()

      yield* contacts.add({ networkID: first.networkID, petname: "someone" })
      expect(yield* successions.remember(cosignedRotation(first, second))).toBe(true)
      expect(yield* successions.remember(cosignedRotation(second, third))).toBe(true)
      yield* contacts.followAll(yield* successions.known())

      expect(yield* contacts.forget(third.networkID)).toBe(true)

      // Nothing left to serve on the peer door, and nothing left to walk a dossier back through.
      expect(yield* successions.known()).toEqual([])
      expect(yield* contacts.get(first.networkID)).toBeUndefined()
      expect(yield* contacts.get(third.networkID)).toBeUndefined()
    }),
  )

  it.effect("🔴 a dealing attached through the SUCCESSION table is forgotten with them", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const ledger = yield* CommunityObservation.Service
      const peers = yield* CommunityPeers.Service
      const successions = yield* CommunitySuccession.Store
      const before = mintIdentity()
      const after = mintIdentity()

      // Dealt with under the OLD key, rotated, and only the new key is a contact — so the old key is
      // reachable only through the succession store, which is exactly what the chain used to miss.
      yield* peers.learn(before.networkID, ["https://peer.example"], "lan")
      yield* ledger.record({ subject: before.networkID, at: 1_000, context: "delivery", outcome: "missed" })
      expect(yield* successions.remember(cosignedRotation(before, after))).toBe(true)
      yield* contacts.add({ networkID: after.networkID, petname: "the same person, new key" })

      expect(yield* ledger.about(after.networkID)).toHaveLength(1)
      expect(yield* contacts.forget(after.networkID)).toBe(true)
      expect(yield* ledger.about(after.networkID)).toEqual([])
      expect(yield* ledger.about(before.networkID)).toEqual([])
    }),
  )

  it.effect("🔴 a peer we never ADDED can be forgotten — they are the population the ledger is for", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const ledger = yield* CommunityObservation.Service
      const peers = yield* CommunityPeers.Service
      const stranger = mintIdentity()

      // Nobody adds someone as a contact in order to keep a file on them: dealings accrue against
      // peers met through the network. `forget` answered false here and deleted nothing.
      yield* peers.learn(stranger.networkID, ["https://stranger.example"], "px")
      yield* ledger.record({ subject: stranger.networkID, at: 1_000, context: "asked", outcome: "refused" })
      expect(yield* contacts.get(stranger.networkID), "not a contact, by construction").toBeUndefined()

      expect(yield* contacts.forget(stranger.networkID)).toBe(true)
      expect(yield* ledger.about(stranger.networkID)).toEqual([])
    }),
  )

  it.effect("⚠️ and the control: forgetting somebody unknown is still false", () =>
    Effect.gen(function* () {
      // A `forget` that answered true for everything would pass every test above while telling the
      // user it had erased a person it had never heard of.
      const contacts = yield* CommunityContacts.Service
      expect(yield* contacts.forget(mintIdentity().networkID)).toBe(false)
    }),
  )
})
