import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityMessageTable } from "@novaclaw/core/community/channel.sql"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityTopic } from "@novaclaw/core/community/topic"
import { CommunityWork } from "@novaclaw/core/community/work"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P4 — the channel log (`todo/community-p2p.md`).
 *
 * Gossip reaches whoever is online, so this is the half that makes a channel readable by someone who
 * was away. What these pin is the ingress door: everything a hostile peer can send has to be refused
 * HERE, because there is no moderator anywhere else.
 */

const it = testEffect(
  LayerNode.compile(
    // Contacts is listed explicitly as well as being a dependency of Channels: the blocking case
    // drives it directly, and a service that is only a transitive dep is not in scope for the test.
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityContacts.node,
      CommunityChannels.node,
    ]),
  ),
)

const CHANNEL = CommunityChannels.DEFAULT_CHANNEL

/**
 * A message from SOMEONE ELSE — the case a forum consists of.
 *
 * ⚠️ Every other test here signs with this instance's own identity, which exercises the loop back to
 * ourselves and never the path that actually matters: bytes from a stranger's key. This mints a
 * fresh keypair and signs through the SAME `canonicalBytes` the product uses, because a second
 * encoder in the test would be a second protocol and would agree with itself while disagreeing with
 * every real peer.
 */
/** Signed + PROVEN: `record` refuses work that does not clear the difficulty, so tests must pay it. */
const proven = (message: CommunityMessage.Signed) => CommunityWork.prove(message)!

const fromStranger = (input: { channel: string; body: string; at?: number }) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  const unsigned = {
    channel: input.channel,
    author: `nid_${raw.toString("base64url")}`,
    at: input.at ?? Date.now(),
    body: input.body,
  }
  const signature = nodeSign(null, Buffer.from(CommunityMessage.canonicalBytes(unsigned)), privateKey)
  return { ...unsigned, signature: signature.toString("base64url") } satisfies CommunityMessage.Signed
}

describe("CommunityChannels", () => {
  it.effect("a joined channel records a verified message, and history reads it back", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      const message = yield* CommunityMessage.sign({ channel: CHANNEL, body: "hello" })

      const result = yield* channels.record(CHANNEL, proven(message))
      expect("stored" in result).toBe(true)
      const history = yield* channels.history(CHANNEL)
      expect(history.map((m) => m.body)).toEqual(["hello"])
      expect(history[0]?.receivedAt).toBeGreaterThan(0)
      expect((yield* channels.channels()).map((c) => c.name)).toEqual([CHANNEL])
    }),
  )

  it.effect("🔴 the ingress door refuses everything it should", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      const message = yield* CommunityMessage.sign({ channel: CHANNEL, body: "hi" })

      // Not subscribed: a topic we never joined must not fill our disk.
      expect(yield* channels.record(CHANNEL, proven(message))).toEqual({ rejected: "not-subscribed" })

      yield* channels.join(CHANNEL)
      // Tampered: the signature no longer covers the body.
      expect(yield* channels.record(CHANNEL, proven({ ...message, body: "edited" }))).toEqual({ rejected: "unverified" })
      // Replayed from another channel onto this topic, signature perfectly valid.
      const elsewhere = yield* CommunityMessage.sign({ channel: "#elsewhere", body: "out of context" })
      expect(yield* channels.record(CHANNEL, proven(elsewhere))).toEqual({ rejected: "wrong-channel" })

      // The honest one lands, and the SAME message arriving again from another mesh peer is a
      // duplicate rather than a second entry — the normal case in a gossip mesh.
      expect("stored" in (yield* channels.record(CHANNEL, proven(message)))).toBe(true)
      expect(yield* channels.record(CHANNEL, proven(message))).toEqual({ rejected: "duplicate" })
      expect((yield* channels.history(CHANNEL)).length).toBe(1)
    }),
  )

  it.effect("🔴 a message WITHOUT valid work is refused — the flood defence", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      const signed = yield* CommunityMessage.sign({ channel: CHANNEL, body: "cheap to send" })

      // Perfectly signed, genuinely ours, and REFUSED — because a flooder's messages are also
      // perfectly signed. Measured: peer scoring rated a flooder at the CAP, so the signature says
      // nothing about whether this cost anything to produce.
      expect(yield* channels.record(CHANNEL, { ...signed, nonce: 0 })).toEqual({ rejected: "unproven" })
      expect(yield* channels.record(CHANNEL, { ...signed, nonce: -1 })).toEqual({ rejected: "unproven" })
      expect(yield* channels.history(CHANNEL)).toEqual([])

      // With the work done, the same message lands.
      expect("stored" in (yield* channels.record(CHANNEL, proven(signed)))).toBe(true)
    }),
  )

  it.effect("🔴 work does not transfer between messages", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      const first = proven(yield* CommunityMessage.sign({ channel: CHANNEL, body: "one" }))
      const second = yield* CommunityMessage.sign({ channel: CHANNEL, body: "two" })

      // Solving once and reusing the nonce is exactly how a flooder would avoid paying per message.
      // The work binds to the SIGNATURE, so it cannot be carried across.
      expect(yield* channels.record(CHANNEL, { ...second, nonce: first.nonce })).toEqual({ rejected: "unproven" })
    }),
  )

  it.effect("🔴 deliver resolves a TOPIC to a joined channel, and refuses one we never joined", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      const message = proven(yield* CommunityMessage.sign({ channel: CHANNEL, body: "from the wire" }))

      // The sidecar knows only a topic id — a hash it cannot invert. Resolution against OUR joined
      // channels is what turns that into a channel name.
      const landed = yield* channels.deliver(CommunityTopic.topicOf(CHANNEL), message)
      expect("stored" in landed).toBe(true)
      expect((yield* channels.history(CHANNEL)).map((m) => m.body)).toEqual(["from the wire"])

      // A topic for a channel we never joined is UNRESOLVABLE, so "not subscribed" is enforced by
      // arithmetic rather than by a check that could be forgotten.
      expect(yield* channels.deliver(CommunityTopic.topicOf("#never-joined"), message)).toEqual({
        rejected: "unknown-topic",
      })
      // And a topic that resolves still passes every rule `record` enforces — here, the work check.
      expect(yield* channels.deliver(CommunityTopic.topicOf(CHANNEL), { ...message, nonce: 0 })).toEqual({
        rejected: "unproven",
      })
    }),
  )

  it.effect("🔴 a blocked author is dropped at INGRESS, not hidden at read", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      const contacts = yield* CommunityContacts.Service
      const identity = yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))
      yield* channels.join(CHANNEL)

      yield* contacts.add({ networkID: identity.networkID, routes: ["/ip4/127.0.0.1/udp/1/quic-v1"] })
      yield* contacts.setBlocked(identity.networkID, true)

      const message = yield* CommunityMessage.sign({ channel: CHANNEL, body: "spam" })
      // Storing then hiding would let a blocked spammer keep filling the disk at the ~9.8k msg/s the
      // flood test measured: blocked in the UI, still paid for in full.
      expect(yield* channels.record(CHANNEL, proven(message))).toEqual({ rejected: "blocked" })
      expect(yield* channels.history(CHANNEL)).toEqual([])
    }),
  )

  it.effect("🔴 history is ordered by RECEIVED time, not the author's claim", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)

      const honest = yield* CommunityMessage.sign({ channel: CHANNEL, body: "first", at: Date.now() })
      yield* channels.record(CHANNEL, proven(honest))
      // A peer dating itself in the year 3000. Sorting by the claim would pin it above everyone
      // else's messages forever, in every reader's view, with no authority able to say otherwise.
      const liar = yield* CommunityMessage.sign({ channel: CHANNEL, body: "pinned", at: 32_503_680_000_000 })
      yield* channels.record(CHANNEL, proven(liar))
      const later = yield* CommunityMessage.sign({ channel: CHANNEL, body: "latest", at: Date.now() })
      yield* channels.record(CHANNEL, proven(later))

      const bodies = (yield* channels.history(CHANNEL)).map((m) => m.body)
      expect(bodies[0]).toBe("latest")
      expect(bodies).toEqual(["latest", "pinned", "first"])
    }),
  )

  it.effect("leaving keeps history — it is not a destructive act", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      yield* channels.record(CHANNEL, proven(yield* CommunityMessage.sign({ channel: CHANNEL, body: "kept" })))

      expect(yield* channels.leave(CHANNEL)).toBe(true)
      expect(yield* channels.channels()).toEqual([])
      // Rejoining must not show an empty room the user knows had messages.
      expect((yield* channels.history(CHANNEL)).map((m) => m.body)).toEqual(["kept"])
    }),
  )

  it.effect("🔴 a message from a STRANGER's key verifies and records — the forum's whole point", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)

      // Not a contact, not us: exactly what arrives on an open channel from someone you have never
      // met. Nothing about verification may depend on knowing the author beforehand.
      const stranger = fromStranger({ channel: CHANNEL, body: "hello from outside" })
      expect(CommunityMessage.verify(stranger)).toBe(true)
      expect("stored" in (yield* channels.record(CHANNEL, proven(stranger)))).toBe(true)
      expect((yield* channels.history(CHANNEL)).map((m) => m.body)).toEqual(["hello from outside"])

      // And a forged one from that same author is refused: an attacker who knows a stranger's
      // public key must not be able to speak as them.
      const forged = { ...stranger, body: "words they never wrote" }
      expect(CommunityMessage.verify(forged)).toBe(false)
      expect(yield* channels.record(CHANNEL, proven(forged))).toEqual({ rejected: "unverified" })
    }),
  )

  it.effect("🔴 the retention bound holds when every message shares one millisecond", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // Exactly the flood's shape: ~10 messages per millisecond means ties are the NORMAL case, and
      // here every row shares one timestamp. The first prune deleted `received_at < cutoff`, so the
      // cutoff equalled every row's value, `<` matched nothing, and the bound deleted ZERO rows
      // while the table grew without limit — failing precisely where it was needed.
      const frozen = 1_700_000_000_000
      for (let i = 0; i < 40; i++)
        yield* db
          .insert(CommunityMessageTable)
          .values({
            id: `id-${i}`,
            channel: CHANNEL,
            author: `nid_${Buffer.alloc(32, 1).toString("base64url")}`,
            claimed_at: frozen,
            received_at: frozen,
            body: `m${i}`,
            signature: "x",
          })
          .run()

      yield* CommunityChannels.prune(db, CHANNEL, 10)
      const left = yield* db.select().from(CommunityMessageTable).all()
      expect(left).toHaveLength(10)
      // And it kept the NEWEST ten, deterministically, rather than an arbitrary ten.
      expect(left.map((r) => r.body).sort()).toEqual(
        ["m30", "m31", "m32", "m33", "m34", "m35", "m36", "m37", "m38", "m39"].sort(),
      )
    }),
  )

  it.effect("the message id is stable across peers, so dedup works between instances", () =>
    Effect.gen(function* () {
      const message = yield* CommunityMessage.sign({ channel: CHANNEL, body: "x" })
      // Derived from the canonical bytes, so two instances that received the same message compute
      // the same id — dedup that depended on a local counter would fail exactly where it matters.
      expect(CommunityChannels.messageID(message)).toBe(CommunityChannels.messageID({ ...message }))
      expect(CommunityChannels.messageID(message)).toHaveLength(64)
    }),
  )
})
