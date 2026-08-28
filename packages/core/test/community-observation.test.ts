import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunitySuccessionTable } from "@novaclaw/core/community/sql"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"
import { cosignedRotation, mintIdentity, type MintedIdentity } from "./lib/community"

/**
 * Community — HONESTY, the per-peer ledger (`notes/spec/honesty-ledger.md`).
 *
 * What these pin is the substrate, not a scoring policy: dealings go in, dealings come out attached
 * to the PERSON rather than to the key they happened to hold, and nothing here can promote a peer
 * into the address book.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunitySuccession.node,
      CommunityContacts.node,
      CommunityPeers.node,
      CommunityObservation.node,
    ]),
  ),
)

/** A fresh identity nobody has met, plus the ability to sign as it. */
const stranger = mintIdentity

/**
 * `predecessor` saying it is now `successor`, **and the successor accepting** (review 1.4).
 *
 * ⚠️ The successor is now a KEYPAIR rather than a bare id: a statement needs both signatures, so a
 * fixture that could only produce one half would be building a forgery and asserting it works.
 */
const rotation = (from: MintedIdentity, to: MintedIdentity, at = Date.now()) => cosignedRotation(from, to, at)

/**
 * 🔴 Engagement, established the way the network really does it — peer exchange handing us an
 * address. `record` refuses a subject this instance has never encountered, so every test that means
 * to record a dealing must first have HAD one; a test that skipped this would be asserting against
 * the refusal path while believing it tested the happy one.
 */
let port = 20_000
const met = (peers: CommunityPeers.Interface, networkID: string) =>
  // ⚠️ A DISTINCT route per peer. `learn` deletes any other row claiming the same address, since
  // one address answers as one instance — so a shared route made the second call quietly evict the
  // first peer, and the dealing recorded against it was then refused as a stranger's.
  // ⚠️ A full URL from a DIALLED source. `learn` validates routes at store time since review 1.3
  // (a scheme-less string is not a route anything could dial) and refuses loopback from HEARSAY,
  // so the old `px` + bare `127.0.0.1:port` fixture now stores nothing at all.
  peers.learn(networkID, [`http://127.0.0.1:${++port}`], "lan")

describe("CommunityObservation", () => {
  it.effect("a dealing goes in and comes back out", () =>
    Effect.gen(function* () {
      const ledger = yield* CommunityObservation.Service
      const peers = yield* CommunityPeers.Service
      const peer = stranger().networkID
      yield* met(peers, peer)

      yield* ledger.record({
        subject: peer,
        at: 1_000,
        context: "news",
        outcome: "contradicted",
        note: "claimed the bridge was down; two peers who were there said otherwise",
        about: "msg_123",
      })

      const dealings = yield* ledger.about(peer)
      expect(dealings.length).toBe(1)
      expect(dealings[0]!.context).toBe("news")
      expect(dealings[0]!.outcome).toBe("contradicted")
      expect(dealings[0]!.at).toBe(1_000)
      expect(dealings[0]!.about).toBe("msg_123")
    }),
  )

  it.effect("🔴 the record follows the PERSON through a rotation, asked by either key", () =>
    Effect.gen(function* () {
      const ledger = yield* CommunityObservation.Service
      const peers = yield* CommunityPeers.Service
      const successions = yield* CommunitySuccession.Store
      const before = stranger()
      const after = stranger()
      yield* met(peers, before.networkID)
      yield* met(peers, after.networkID)

      // Dealt with under the old key, and only then do they rotate — the order that matters.
      yield* ledger.record({ subject: before.networkID, at: 1_000, context: "delivery", outcome: "kept" })
      expect(yield* successions.remember(rotation(before, after))).toBe(true)
      yield* ledger.record({ subject: after.networkID, at: 2_000, context: "delivery", outcome: "missed" })

      // ⚠️ Asked by the NEW key, the old dealing is still theirs. That is the whole anti-whitewash
      // claim: the past stays attached to the person who earned it.
      const byNew = yield* ledger.about(after.networkID)
      expect(byNew.length).toBe(2)
      expect(byNew.map((entry) => entry.outcome)).toEqual(["missed", "kept"])

      // And asked by the key we originally met, we reach the dealings that came later.
      const byOld = yield* ledger.about(before.networkID)
      expect(byOld.length).toBe(2)
    }),
  )

  it.effect("🔴 the chain outlives the record, for a peer who is NOT a contact", () =>
    Effect.gen(function* () {
      const ledger = yield* CommunityObservation.Service
      const peers = yield* CommunityPeers.Service
      const successions = yield* CommunitySuccession.Store
      const contacts = yield* CommunityContacts.Service
      const before = stranger()
      const after = stranger()
      yield* met(peers, before.networkID)

      yield* ledger.record({ subject: before.networkID, at: 1_000, context: "delivery", outcome: "missed" })
      expect(yield* successions.remember(rotation(before, after))).toBe(true)

      /**
       * 🔴 The subject must NOT be a contact, or this test passes without proving anything: a
       * contact's chain lives on the contact row and is never evicted, so the pin under test would
       * be dead code and the assertion would still hold.
       */
      expect(yield* contacts.get(before.networkID)).toBeUndefined()
      expect(yield* contacts.get(after.networkID)).toBeUndefined()

      // Enough unrelated rotations to push the cap past our statement several times over.
      for (let index = 0; index < CommunitySuccession.MAX_STATEMENTS + 50; index++) {
        const noise = stranger()
        yield* successions.remember(rotation(noise, stranger()))
      }

      // ⚠️ Without the eviction pin this is where the record silently detaches: the link is gone,
      // so the old dealing belongs to a key nobody can connect to the peer standing in front of us.
      const dealings = yield* ledger.about(after.networkID)
      expect(dealings.length).toBe(1)
      expect(dealings[0]!.outcome).toBe("missed")
    }),
  )

  it.effect("⚠️ the pin is load-bearing: an UNOBSERVED link does evict", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const successions = yield* CommunitySuccession.Store
      const before = stranger()
      const after = stranger()

      // Identical to the test above except that nothing was ever recorded about this peer. If this
      // ALSO survived, the pin would be proving nothing and the cap would simply not be working.
      expect(yield* successions.remember(rotation(before, after))).toBe(true)
      for (let index = 0; index < CommunitySuccession.MAX_STATEMENTS + 50; index++) {
        const noise = stranger()
        yield* successions.remember(rotation(noise, stranger()))
      }

      // Observed DIRECTLY rather than through the chain walk: the statement itself is gone, which is
      // the fact the pinned case depends on not happening.
      const surviving = yield* db
        .select()
        .from(CommunitySuccessionTable)
        .where(eq(CommunitySuccessionTable.network_id, before.networkID))
        .all()
      expect(surviving.length).toBe(0)
    }),
  )

  it.effect("🔴 a dealing we PERFORMED is recorded even with a total stranger", () =>
    Effect.gen(function* () {
      const ledger = yield* CommunityObservation.Service
      const contacts = yield* CommunityContacts.Service
      const asker = stranger().networkID

      /**
       * ⚠️ The engagement bound refuses this subject through `record` — correctly, since that
       * path is written by an agent reading strangers. But answering a question IS the encounter, and
       * routing it through the bounded path meant every FIRST-TIME asker was dropped: the ledger
       * never learned we had dealt with them, which is the one thing it exists to remember.
       */
      expect(
        yield* ledger.record({ subject: asker, at: 1_000, context: "answer", outcome: "answered" }),
      ).toBeUndefined()

      const id = yield* ledger.recordFirstHand({ subject: asker, at: 2_000, context: "answer", outcome: "answered" })
      expect(id).toBeTruthy()
      expect((yield* ledger.about(asker)).length).toBe(1)

      // — and it still cannot introduce them. A dealing is not a relationship.
      expect(yield* contacts.get(asker)).toBeUndefined()
    }),
  )

  it.effect("🔴 recording a dealing never introduces anyone", () =>
    Effect.gen(function* () {
      const ledger = yield* CommunityObservation.Service
      const contacts = yield* CommunityContacts.Service
      const peers = yield* CommunityPeers.Service
      const peer = stranger().networkID
      yield* met(peers, peer)
      const before = yield* contacts.list()

      // Every outcome shape, in case one of them were ever tempted to "helpfully" remember a peer.
      yield* ledger.record({ subject: peer, at: 1_000, context: "delivery", outcome: "kept" })
      yield* ledger.record({ subject: peer, at: 2_000, context: "news", outcome: "confirmed" })
      yield* ledger.record({ subject: peer, at: 3_000, context: "trade", outcome: "paid" })

      // The contact list is the user's sentence about who they know; a good reputation is not an
      // introduction, and three flawless dealings must still leave a stranger a stranger.
      expect(yield* contacts.get(peer)).toBeUndefined()
      expect((yield* contacts.list()).length).toBe(before.length)
      expect((yield* ledger.about(peer)).length).toBe(3)
    }),
  )

  it.effect("no verdict is stored — only dealings", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const columns = yield* db.all<{ name: string }>(sql`PRAGMA table_info(community_observation)`)
      const names = columns.map((column) => column.name)
      for (const forbidden of ["score", "weight", "stake", "confidence", "trust", "rating"]) {
        expect(names).not.toContain(forbidden)
      }
    }),
  )
})
