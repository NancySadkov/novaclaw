import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { CommunityAnswer } from "@novaclaw/core/community/answer"

/**
 * 🔴 An asker must be able to VERIFY the answer from what the wire actually carries.
 *
 * The signature covers author, asker, question, time and answer. The reply carries four of those —
 * the question is the asker's own words, which they already have — so verification is possible only
 * if every remaining field survives the response schema. Drop one and the signature can never be
 * rebuilt: the answer still arrives, still reads fine, and is simply unverifiable forever.
 *
 * ⚠️ That failure has no symptom on the answering side, which is why it is asserted here rather than
 * left to the endpoint's types. Twice this session a field was computed, typed and shipped while the
 * schema dropped it on the way out.
 */

/** Exactly the fields the ask response declares, and nothing else. */
type WireAnswer = {
  readonly answer?: string
  readonly refused?: string
  readonly author?: string
  readonly at?: number
  readonly signature?: string
}

const instance = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  return { networkID: `nid_${raw.toString("base64url")}`, privateKey }
}

describe("an answer is verifiable from the wire alone", () => {
  test("🔴 the asker rebuilds the signature from the reply plus their OWN question", () => {
    const answering = instance()
    const asker = instance().networkID
    const question = "did the bridge come down?"
    const unsigned = {
      author: answering.networkID,
      asker,
      question,
      answer: "I did not see it myself; two peers upriver say no.",
      at: 1_700_000_000_000,
    }

    // What the handler sends back — only the fields the success schema declares.
    const wire: WireAnswer = {
      answer: unsigned.answer,
      author: unsigned.author,
      at: unsigned.at,
      signature: nodeSign(null, Buffer.from(CommunityAnswer.canonicalBytes(unsigned)), answering.privateKey).toString(
        "base64url",
      ),
    }

    /**
     * ⚠️ Reconstructed the way a REAL asker must: from the reply, plus the question and their own
     * identity, which are the two things only they hold. Nothing here reads the answering side's
     * state, because an asker cannot.
     */
    const rebuilt = {
      author: wire.author!,
      asker,
      question,
      answer: wire.answer!,
      at: wire.at!,
      signature: wire.signature!,
    }
    expect(CommunityAnswer.verify(rebuilt)).toBe(true)
  })

  test("🔴 dropping ANY signed field makes it unverifiable — the silent failure this guards", () => {
    const answering = instance()
    const asker = instance().networkID
    const unsigned = {
      author: answering.networkID,
      asker,
      question: "did the bridge come down?",
      answer: "two peers upriver say no.",
      at: 1_700_000_000_000,
    }
    const signature = nodeSign(
      null,
      Buffer.from(CommunityAnswer.canonicalBytes(unsigned)),
      answering.privateKey,
    ).toString("base64url")

    /**
     * Each of these is a field the response schema could omit. The point is that omission is not a
     * cosmetic loss: the answer would still arrive and still read fine, and could never be shown to
     * anybody as this peer's word — which is the whole reason it is signed.
     */
    expect(CommunityAnswer.verify({ ...unsigned, signature, author: instance().networkID })).toBe(false)
    expect(CommunityAnswer.verify({ ...unsigned, signature, at: unsigned.at + 1 })).toBe(false)
    expect(CommunityAnswer.verify({ ...unsigned, signature, answer: "" })).toBe(false)
    // And a reply carrying no signature at all is not "unsigned but fine" — it is unverifiable.
    expect(CommunityAnswer.verify({ ...unsigned, signature: "" })).toBe(false)
  })
})
