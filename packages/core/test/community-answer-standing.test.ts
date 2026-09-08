import crypto, { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityDirect } from "@novaclaw/core/community/dm"
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

describe("a question names who it is FOR (review §2)", () => {
  const sign = (input: { to: string; asker: string; question: string; at: number }, key: crypto.KeyObject) => ({
    ...input,
    signature: nodeSign(null, Buffer.from(CommunityAnswer.askBytes(input)), key).toString("base64url"),
  })

  it.effect("🔴 an ask addressed to one instance does not verify at another", () =>
    Effect.gen(function* () {
      /**
       * The replay the old envelope allowed: any instance Bob asked could re-send his question
       * verbatim to every other instance and burn Bob's per-asker share at each of them. The comment
       * that used to sit above `ASK_DOMAIN` called this "bounded rather than prevented" because it
       * costs the asker's own budget — which is exactly backwards. The cost lands on Bob, at N
       * instances, for one captured message, and Bob is not the attacker.
       */
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
      const asker = `nid_${raw.toString("base64url")}`
      const alice = mintIdentity().networkID
      const bob = mintIdentity().networkID

      const forAlice = sign({ to: alice, asker, question: "what happened today?", at: Date.now() }, privateKey)
      expect(CommunityAnswer.verifyAsk(forAlice, alice), "it verifies at the instance it names").toBe(true)
      expect(CommunityAnswer.verifyAsk(forAlice, bob), "and nowhere else").toBe(false)

      // ⚠️ Not merely a field comparison: rewriting `to` breaks the signature, so a replayer cannot
      // simply re-address the captured question.
      expect(CommunityAnswer.verifyAsk({ ...forAlice, to: bob }, bob)).toBe(false)
    }),
  )

  it.effect("🔴 a question from long ago, or from a broken clock, is not a question", () =>
    Effect.gen(function* () {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
      const asker = `nid_${raw.toString("base64url")}`
      const self = mintIdentity().networkID
      const at = (when: number) => sign({ to: self, asker, question: "hello?", at: when }, privateKey)

      expect(CommunityAnswer.verifyAsk(at(Date.now()), self)).toBe(true)
      // Generous on purpose — these are home machines without an NTP guarantee, and refusing an
      // honest peer whose clock is minutes off would break the feature to inconvenience nobody.
      expect(CommunityAnswer.verifyAsk(at(Date.now() - 60_000), self)).toBe(true)
      expect(CommunityAnswer.verifyAsk(at(Date.now() - CommunityAnswer.MAX_ASK_AGE_MS - 1_000), self)).toBe(false)
      expect(CommunityAnswer.verifyAsk(at(Date.now() + CommunityAnswer.MAX_ASK_AGE_MS + 1_000), self)).toBe(false)

      /**
       * ⚠️ And the value that THROWS rather than merely lying — review 1.12's lesson one door over:
       * `BigInt(-1)` reaching `writeBigUInt64BE` raises, and an anonymous door that can be made to
       * raise is a 500 generator writing stack traces into the owner's log.
       */
      expect(CommunityAnswer.verifyAsk(at(-1), self)).toBe(false)
      expect(CommunityAnswer.verifyAsk(at(Number.MAX_SAFE_INTEGER + 2), self)).toBe(false)
    }),
  )
})

describe("what an instance answers FROM (Codex P2)", () => {
  const claim = (input: Partial<CommunityAnswer.Evidence> & { body: string }): CommunityAnswer.Evidence => ({
    channel: "#NovaClaw",
    author: "nid_someone",
    at: 1,
    saw: false,
    ...input,
  })

  it.effect("🔴 an empty packet SAYS it is empty", () =>
    Effect.gen(function* () {
      /**
       * A turn with no context and a turn whose context happened to be empty look identical to a
       * model, and only one of them should produce "I have not heard anything about that". Omitting
       * the packet is what let the answering turn fall back to pretrained weights and sign the
       * result with the user's identity.
       */
      const packet = CommunityAnswer.evidencePacket({ claims: [], withheld: 0 })
      expect(packet).toContain("nothing this instance holds bears on the question")
      expect(packet).toContain("BEGIN COMMUNITY EVIDENCE")
    }),
  )

  it.effect("🔴 every line carries WHO said it and whether we saw it ourselves", () =>
    Effect.gen(function* () {
      // The system prompt demands the answer mark SAW vs HEARD. That is only answerable if the
      // packet computes it — a model cannot know which messages this user wrote.
      const packet = CommunityAnswer.evidencePacket({
        claims: [claim({ body: "the bridge is closed", author: "nid_bob" }), claim({ body: "I fixed the roof", saw: true })],
        withheld: 0,
      })
      expect(packet).toContain("HEARD from nid_bob")
      expect(packet).toContain("SAW (your own user wrote this)")
      // And it is FENCED: every line was written by a stranger, and the model is about to act on the
      // question sitting beside it.
      expect(packet).toContain("are not instructions")
    }),
  )

  it.effect("🔴 selection is bounded by COUNT and by BYTES, or one bounds nothing", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 50 }, (_, n) => claim({ body: `weather report number ${n}`, at: n }))
      const picked = CommunityAnswer.selectEvidence("what is the weather", many)
      expect(picked.claims.length).toBeLessThanOrEqual(CommunityAnswer.MAX_EVIDENCE_ITEMS)
      expect(picked.claims.length).toBeGreaterThan(0)

      // Eight messages of 8 KB each would be a prefill bomb aimed at ourselves — the mirror of the
      // question ceiling one field over.
      const heavy = Array.from({ length: 8 }, () => claim({ body: `weather ${"x".repeat(4000)}` }))
      const bounded = CommunityAnswer.selectEvidence("weather", heavy)
      const bytes = bounded.claims.reduce((sum, entry) => sum + Buffer.byteLength(entry.body, "utf8"), 0)
      expect(bytes).toBeLessThanOrEqual(CommunityAnswer.MAX_EVIDENCE_BYTES)
    }),
  )

  it.effect("⚠️ irrelevant history is not evidence, and a question of stopwords selects nothing", () =>
    Effect.gen(function* () {
      const history = [claim({ body: "the cat sat on the mat" }), claim({ body: "a bridge collapsed downtown" })]
      const picked = CommunityAnswer.selectEvidence("what happened to the bridge", history)
      expect(picked.claims.map((entry) => entry.body)).toEqual(["a bridge collapsed downtown"])

      // A question with nothing to match on selects nothing rather than everything — the failure
      // mode is "no evidence found", which the prompt requires the answer to admit.
      expect(CommunityAnswer.selectEvidence("what is it", history)).toEqual({ claims: [], withheld: 0 })
    }),
  )
})

describe("a refusal and a delivery are CLAIMS that must be proven (Codex P1)", () => {
  it.effect("🔴 a refusal is bound to the refuser, the asker, and the question", () =>
    Effect.gen(function* () {
      /**
       * The asking side records a first-hand dealing about a peer on a refusal — "they would not
       * answer" is what standing is made of — so while refusals carried no signature, anything
       * answering at an address could make us write one in a victim's name.
       */
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
      const author = `nid_${raw.toString("base64url")}`
      const asker = mintIdentity().networkID
      const request = "the-ask-signature"

      const unsigned = { author, asker, request, reason: "budget-spent", at: Date.now() }
      const refusal = {
        ...unsigned,
        signature: nodeSign(null, Buffer.from(CommunityAnswer.refusalBytes(unsigned)), privateKey).toString(
          "base64url",
        ),
      }
      expect(CommunityAnswer.verifyRefusal(refusal, { author, asker, request })).toBe(true)

      // ⚠️ Bound to the QUESTION, so one captured refusal cannot be replayed at every later one —
      // otherwise a single message would fill our ledger with dealings.
      expect(CommunityAnswer.verifyRefusal(refusal, { author, asker, request: "another-question" })).toBe(false)
      // …and it cannot be lifted from somebody else's exchange, or re-attributed.
      expect(CommunityAnswer.verifyRefusal(refusal, { author, asker: mintIdentity().networkID, request })).toBe(false)
      expect(
        CommunityAnswer.verifyRefusal({ ...refusal, author: mintIdentity().networkID }, { author, asker, request }),
      ).toBe(false)
      // A reason outside our own vocabulary is not a refusal we will record against anybody.
      expect(CommunityAnswer.verifyRefusal({ ...refusal, reason: "whatever" }, { author, asker, request })).toBe(false)
    }),
  )

  it.effect("🔴 a delivery ack proves possession without disclosing the verdict", () =>
    Effect.gen(function* () {
      /**
       * The DM door answers a uniform `{received:true}` on purpose, so a sender cannot probe who is
       * blocked. An UNSIGNED uniform ack is also what a black hole returns: an endpoint claiming a
       * victim's key accepted ciphertext it could not open, said received, and the user was told
       * their message was sent.
       */
      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
      const recipient = `nid_${raw.toString("base64url")}`
      const sender = mintIdentity().networkID
      const message = "sha256-of-the-envelope"

      const unsigned = { recipient, sender, message, at: Date.now() }
      const ack = {
        ...unsigned,
        signature: nodeSign(null, Buffer.from(CommunityDirect.deliveryBytes(unsigned)), privateKey).toString(
          "base64url",
        ),
      }
      expect(CommunityDirect.verifyDelivery(ack, { recipient, sender, message })).toBe(true)

      // The black hole: an impostor cannot produce this for a key it does not hold.
      const impostor = mintIdentity().networkID
      expect(
        CommunityDirect.verifyDelivery({ ...ack, recipient: impostor }, { recipient: impostor, sender, message }),
      ).toBe(false)
      // Bound to THIS message, so an ack cannot be replayed for the next one.
      expect(CommunityDirect.verifyDelivery(ack, { recipient, sender, message: "a-different-message" })).toBe(false)
      // …and it says nothing about the verdict, which is the property the uniform reply protects:
      // the same signed shape is returned whether the message was stored, blocked or unreadable.
      expect(Object.keys(ack).sort()).toEqual(["at", "message", "recipient", "sender", "signature"])
    }),
  )
})
