import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunityStanding } from "@novaclaw/core/community/standing"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"
import { mintIdentity } from "./lib/community"

/**
 * 🔴 Codex review P1 — **answering ignored the four-rung ladder it was designed around.**
 *
 * `allowed` consulted joined/enabled, the global daily count and a flat per-key count. Nothing else.
 * So with the defaults, four disposable keys took all twenty of the day's answers at five each,
 * before the user's own doorman or anybody they had ever dealt with got to ask — the exact Sybil
 * shape the introduction edge and the non-transitive ladder exist to distinguish. Having an
 * observation store did not make answering trust-aware.
 *
 * ⚠️ What is pinned here is the ORDERING and EXPOSURE invariants, not a scoring formula. The honesty
 * ledger is an experiment; a permanent numerical reputation baked into an admission path would
 * outlive every decision anyone made about it.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityContacts.node,
      CommunityPeers.node,
      CommunityObservation.node,
      CommunityAnswer.node,
    ]),
  ),
)

const stores = Effect.gen(function* () {
  return {
    contacts: yield* CommunityContacts.Service,
    peers: yield* CommunityPeers.Service,
    observations: yield* CommunityObservation.Service,
  }
})

/** Answering ON with a known budget, so the share arithmetic is stated rather than inherited. */
const answering = (perDay: number) =>
  CommunityConsent.applied(
    { consented: true, enabled: true, answers: { enabled: true, perDay, perPeerPerDay: perDay } },
    { enabled: false },
  )

describe("the four rungs (AGENTS.md) decide who may spend the answering budget", () => {
  it.effect("🔴 a rung is read from dealings, the user's rating, and ONE introduction hop", () =>
    Effect.gen(function* () {
      const s = yield* stores
      const contacts = yield* CommunityContacts.Service
      const peers = yield* CommunityPeers.Service
      const observations = yield* CommunityObservation.Service

      const stranger = mintIdentity().networkID
      const doorman = mintIdentity().networkID
      const vouched = mintIdentity().networkID
      const dealt = mintIdentity().networkID

      expect(yield* CommunityStanding.rungOf(s, stranger)).toBe("stranger")

      // The root is a DECLARATION the user made — a contact they added and rated.
      yield* contacts.add({ networkID: doorman, petname: "my doorman", trust: 5 })
      expect(yield* CommunityStanding.rungOf(s, doorman)).toBe("doorman")

      // Third rung: introduced BY that doorman, by its own answer to a peer exchange.
      /**
       * ⚠️ A DOCUMENTATION address (TEST-NET-3), not loopback: hearsay routes are held to the
       * stricter rule from review 1.3, so `http://127.0.0.1` from a peer-exchange answer is refused
       * at store time and the row is never created. The first version of this test used loopback and
       * failed for that reason — the fixture was wrong, not the rung.
       */
      yield* peers.learn(vouched, ["http://203.0.113.5:4096"], "px", doorman)
      expect(yield* CommunityStanding.rungOf(s, vouched)).toBe("vouched")

      /**
       * 🔴 AND THE LADDER STOPS. A peer introduced by a VOUCHED peer is a stranger: a judge's own
       * recommendation does not create a fifth rung, because trust is not transitive. The obvious
       * implementation — climb `introducedBy` until you find somebody trusted — is one line away at
       * all times, and this is the assertion that catches it.
       */
      const secondHand = mintIdentity().networkID
      yield* peers.learn(secondHand, ["http://203.0.113.6:4096"], "px", vouched)
      expect(yield* CommunityStanding.rungOf(s, secondHand), "the ladder does not extend").toBe("stranger")

      // Our own dealings outrank everything, and resolve through the succession chain.
      yield* observations.recordFirstHand({
        subject: dealt,
        at: Date.now(),
        context: "asked",
        outcome: CommunityObservation.Outcome.ANSWERED,
      })
      expect(yield* CommunityStanding.rungOf(s, dealt)).toBe("own")
    }),
  )

  it.effect("🔴 disposable keys cannot take the whole day", () =>
    Effect.gen(function* () {
      const answers = yield* CommunityAnswer.Service
      const contacts = yield* CommunityContacts.Service
      answering(20)
      // ⚠️ There has to be SOMEBODY for the share to be kept for — see `hasStanding`. This is the
      // user the attack is against: one who has named a doorman and expects to hear from them.
      yield* contacts.add({ networkID: mintIdentity().networkID, petname: "the one who let us in", trust: 4 })

      /**
       * The measured attack: four free keypairs at five answers each. Every one of them is a
       * stranger, so together they may take a QUARTER of the day and not one answer more.
       */
      const ceiling = Math.max(1, Math.floor(20 * CommunityAnswer.STRANGER_SHARE))
      const sybil = Array.from({ length: 4 }, () => mintIdentity().networkID)
      let served = 0
      for (const key of sybil)
        for (let n = 0; n < 5; n++) {
          if ((yield* answers.allowed(key)) !== undefined) continue
          yield* answers.spent(key)
          served++
        }
      expect(served, "strangers share a bounded slice of the budget").toBe(ceiling)
      expect(yield* answers.allowed(mintIdentity().networkID)).toBe("newcomer-share-spent")
    }),
  )

  it.effect("🔴 …and the doorman can still ask after they have tried", () =>
    Effect.gen(function* () {
      /**
       * ⚠️ THE POINT OF THE WHOLE FIX. A filter would also pass the test above and would make this
       * network a club: `honesty-ledger.md` says answer service is ordered, NOT filtered. What the
       * share buys is that the budget is still there for the rungs above when a stranger has spent
       * theirs.
       */
      const answers = yield* CommunityAnswer.Service
      const contacts = yield* CommunityContacts.Service
      answering(20)
      const doorman = mintIdentity().networkID
      yield* contacts.add({ networkID: doorman, petname: "the one who let us in", trust: 4 })

      for (const key of Array.from({ length: 4 }, () => mintIdentity().networkID))
        for (let n = 0; n < 5; n++) {
          if ((yield* answers.allowed(key)) !== undefined) continue
          yield* answers.spent(key)
        }

      expect(yield* answers.allowed(doorman), "the ladder is an ordering, not a filter").toBeUndefined()
    }),
  )

  it.effect("🔴 an instance that knows NOBODY reserves nothing — a fresh install answers freely", () =>
    Effect.gen(function* () {
      /**
       * The case that made the first version of this wrong: with no contacts every asker is a
       * stranger, so a flat quarter would have stranded three quarters of the budget where nothing
       * could claim it, and the user would watch their instance refuse questions it was willing to
       * answer. Caught by an EXISTING budget test, not by this file.
       */
      const answers = yield* CommunityAnswer.Service
      answering(2)
      const newcomer = mintIdentity().networkID
      expect(yield* answers.allowed(newcomer)).toBeUndefined()
      yield* answers.spent(newcomer)
      expect(yield* answers.allowed(newcomer), "nobody to reserve for means nothing is reserved").toBeUndefined()
    }),
  )

  it.effect("⚠️ a newcomer is never locked out entirely, even on a tiny budget", () =>
    Effect.gen(function* () {
      // A share that rounded to zero would turn "bounded access" into "no access", which is the
      // club this design refuses.
      const answers = yield* CommunityAnswer.Service
      const contacts = yield* CommunityContacts.Service
      answering(2)
      yield* contacts.add({ networkID: mintIdentity().networkID, petname: "someone", trust: 3 })
      expect(yield* answers.allowed(mintIdentity().networkID)).toBeUndefined()
    }),
  )
})

describe("what a question may WEIGH (Codex P1)", () => {
  it.effect("🔴 the ceiling is bytes, and one byte over is refused", () =>
    Effect.gen(function* () {
      expect(CommunityAnswer.questionTooLarge("what happened in the world today?")).toBe(false)
      expect(CommunityAnswer.questionTooLarge("x".repeat(CommunityAnswer.MAX_QUESTION_BYTES))).toBe(false)
      expect(CommunityAnswer.questionTooLarge("x".repeat(CommunityAnswer.MAX_QUESTION_BYTES + 1))).toBe(true)
      // BYTES, not characters: a question of CJK weighs three times what a character count claims.
      expect(CommunityAnswer.questionTooLarge("好".repeat(CommunityAnswer.MAX_QUESTION_BYTES / 2))).toBe(true)
    }),
  )
})
