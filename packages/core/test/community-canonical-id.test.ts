import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommunityAnswer } from "@novaclaw/core/community/answer"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityWork } from "@novaclaw/core/community/work"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * 🔴 P2P review 2026-08-17, finding 1.2 — **a key that is really a SPELLING**.
 *
 * `parseNetworkID` decoded with lenient base64url and checked only the LENGTH, so one Ed25519 key
 * had unbounded `nid_…` spellings that every door accepted. Every guard downstream compares the
 * literal string — `contacts.get`, the blocked flag, the DM `peer` column, `answers.allowed`, the
 * per-peer spend row, the message primary key — so re-spelling yourself was a complete laundering
 * route past a block, past a per-peer budget, past dedupe, with no rotation and no new key.
 *
 * Confirmed on the wire during the review: a blocked author's post was STORED through a live
 * instance's `/api/community/inbound` under `nid_…=` while the canonical spelling was refused.
 *
 * ⚠️ These tests do not check that the aliases are rejected as STRINGS — that would pass against a
 * per-door blocklist and tell us nothing. They check that a signature made by the real private key
 * fails at each door when the author NAMES itself non-canonically, which is only true if the parse
 * itself is canonical. The doors are the three the review named: `record`, `receive`, `verifyAsk`.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityContacts.node,
      CommunityChannels.node,
      CommunityDirect.node,
    ]),
  ),
)

const CHANNEL = CommunityChannels.DEFAULT_CHANNEL
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** A real keypair, plus the canonical `nid_` its raw public key encodes to. */
const strangerKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  return { raw, privateKey, canonical: `nid_${raw.toString("base64url")}` }
}

/**
 * Every spelling the review measured, plus the one base64 arithmetic GUARANTEES.
 *
 * 32 bytes is 256 bits and 43 base64 characters is 258, so the last character carries two unused
 * low bits — four distinct characters decode to the same key, always, for every key. The rest
 * (padding, the std alphabet, interior whitespace, trailing junk) exist because Node's decoder
 * skips what it does not recognise rather than refusing it.
 */
const aliasesOf = (canonical: string): ReadonlyArray<string> => {
  const body = canonical.slice("nid_".length)
  const last = body[body.length - 1]!
  const index = ALPHABET.indexOf(last)
  const lowBits = [1, 2, 3].map((bit) => `nid_${body.slice(0, -1)}${ALPHABET[(index & ~3) + bit]!}`)
  return [
    `${canonical}=`,
    `${canonical}==`,
    `${canonical} `,
    `${canonical}!!`,
    `nid_${body.replaceAll("-", "+").replaceAll("_", "/")}`,
    `nid_${body.slice(0, 20)} ${body.slice(20)}`,
    ...lowBits,
  ].filter((alias) => alias !== canonical)
}

/**
 * Only the spellings Node's decoder really does turn back into THIS key — asserted non-empty by
 * every caller. Filtering rather than assuming keeps the test honest if a runtime tightens its
 * decoder: it then has fewer aliases to reject, never a vacuous pass.
 */
const realAliases = (key: { raw: Buffer; canonical: string }) =>
  aliasesOf(key.canonical).filter((alias) => Buffer.from(alias.slice("nid_".length), "base64url").equals(key.raw))

const signChannel = (key: ReturnType<typeof strangerKey>, author: string, body: string) => {
  const unsigned = { channel: CHANNEL, author, at: Date.now(), body }
  const signature = nodeSign(null, Buffer.from(CommunityMessage.canonicalBytes(unsigned)), key.privateKey)
  return CommunityWork.prove({ ...unsigned, signature: signature.toString("base64url") })!
}

describe("a nid_ is a KEY, not a spelling (p2p 1.2)", () => {
  test("the aliases are real: Node decodes each one back to the same key", () => {
    const key = strangerKey()
    const aliases = realAliases(key)
    // The low-bit variants are arithmetic, so at least three must survive the filter on any runtime.
    expect(aliases.length).toBeGreaterThanOrEqual(3)
    // …and the canonical spelling is still a key. A parse that rejected everything would pass every
    // negative assertion below while breaking the network.
    expect(InstanceIdentityStore.parseNetworkID(key.canonical)).toHaveLength(32)
    for (const alias of aliases) expect(InstanceIdentityStore.parseNetworkID(alias)).toBeUndefined()
  })

  test("a signature made by the real key does not verify under an alias name", () => {
    const key = strangerKey()
    const message = Buffer.from("the bytes are honest; the name is not")
    const signature = nodeSign(null, message, key.privateKey)
    expect(InstanceIdentityStore.verifySignature(key.canonical, message, signature)).toBe(true)
    for (const alias of realAliases(key))
      expect(InstanceIdentityStore.verifySignature(alias, message, signature)).toBe(false)
  })

  it.effect("🔴 `record`: a BLOCKED author cannot re-spell their way back into the room", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      const contacts = yield* CommunityContacts.Service
      yield* channels.join(CHANNEL)

      const key = strangerKey()
      yield* contacts.add({ networkID: key.canonical })
      yield* contacts.setBlocked(key.canonical, true)

      // The control: canonically named, the block bites.
      expect(yield* channels.record(CHANNEL, signChannel(key, key.canonical, "spam"))).toEqual({
        rejected: "blocked",
      })

      // The laundering route. Each of these was STORED before the parse was canonical — same key,
      // same private key, same valid signature, a name the blocked-check never matched.
      const aliases = realAliases(key)
      expect(aliases.length).toBeGreaterThanOrEqual(3)
      for (const alias of aliases)
        expect(yield* channels.record(CHANNEL, signChannel(key, alias, "spam"))).toEqual({
          rejected: "unverified",
        })

      expect(yield* channels.history(CHANNEL)).toEqual([])
    }),
  )

  it.effect("🔴 `receive`: the DM door refuses the alias before it refuses anything else", () =>
    Effect.gen(function* () {
      const direct = yield* CommunityDirect.Service
      const store = yield* InstanceIdentityStore.Service
      const self = (yield* store.identity()).networkID
      const key = strangerKey()

      const sealed = { epk: "ZXBr", iv: "aXY", ct: "Y3Q" }
      const send = (from: string) => {
        const unsigned = { to: self, from, at: Date.now(), sealed }
        const signature = nodeSign(null, Buffer.from(CommunityDirect.canonicalBytes(unsigned)), key.privateKey)
        return CommunityWork.prove({ ...unsigned, signature: signature.toString("base64url") })!
      }

      // The control names the key canonically, so it passes verification and is refused LATER, for
      // the ciphertext — which is what proves the alias below fails at the identity check itself
      // rather than at some rule both spellings would trip.
      expect(yield* direct.receive(send(key.canonical))).toEqual({ rejected: "unreadable" })

      const aliases = realAliases(key)
      expect(aliases.length).toBeGreaterThanOrEqual(3)
      for (const alias of aliases) expect(yield* direct.receive(send(alias))).toEqual({ rejected: "unverified" })
    }),
  )

  test("🔴 `verifyAsk`: six spellings of one asker are not six askers", () => {
    const key = strangerKey()
    // ⚠️ `to` is inside the signature now: an ask verifies at the instance it names and nowhere else.
    const self = `nid_${Buffer.alloc(32, 7).toString("base64url")}`
    const ask = (asker: string) => {
      const unsigned = { to: self, asker, question: "what happened in the world today?", at: Date.now() }
      const signature = nodeSign(null, Buffer.from(CommunityAnswer.askBytes(unsigned)), key.privateKey)
      return { ...unsigned, signature: signature.toString("base64url") }
    }

    expect(CommunityAnswer.verifyAsk(ask(key.canonical), self)).toBe(true)
    // Each alias that verified was a fresh `asker` string to `answers.allowed` and to the spend row,
    // so `perPeerPerDay` collapsed to `perDay` and a blocked peer was answered as a stranger.
    for (const alias of realAliases(key)) expect(CommunityAnswer.verifyAsk(ask(alias), self)).toBe(false)
  })
})
