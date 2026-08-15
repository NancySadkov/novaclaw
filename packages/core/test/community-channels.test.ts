import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityMessageTable } from "@novaclaw/core/community/channel.sql"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
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

  it.effect("🔴 a blocked peer's BACKLOG is still blocked after they rotate", () =>
    Effect.gen(function* () {
      /**
       * The defect this pins: `follow` used to DELETE the predecessor's row. Blocking survived onto
       * the successor, so the peer could not post anew — but every message they wrote BEFORE
       * rotating is signed by the deleted key, and reconciliation backfills exactly such messages.
       * They arrived from an author we knew nothing about and were stored. The user blocked a
       * person and would receive that person's history anyway.
       *
       * Nothing local can produce that sequence: it needs a real rotation and a message that
       * predates it, which is why this is written end to end through `record` rather than against
       * the store.
       */
      const channels = yield* CommunityChannels.Service
      const contacts = yield* CommunityContacts.Service
      yield* channels.join(CHANNEL)

      // The peer's first key, and a message they wrote while using it.
      const old = generateKeyPairSync("ed25519")
      const oldID = `nid_${(old.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12).toString("base64url")}`
      const signWith = (key: typeof old.privateKey, author: string, body: string) => {
        const unsigned = { channel: CHANNEL, author, at: Date.now(), body }
        return {
          ...unsigned,
          signature: nodeSign(null, Buffer.from(CommunityMessage.canonicalBytes(unsigned)), key).toString("base64url"),
        } satisfies CommunityMessage.Signed
      }
      const backlog = proven(signWith(old.privateKey, oldID, "written before they rotated"))

      yield* contacts.add({ networkID: oldID, petname: "loud one" })
      expect(yield* contacts.setBlocked(oldID, true)).toBe(true)

      // They rotate, and prove it with a statement signed by the key they are leaving.
      const fresh = generateKeyPairSync("ed25519")
      const newID = `nid_${(fresh.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12).toString("base64url")}`
      const body = { predecessor: oldID, successor: newID, at: Date.now() }
      const statement = {
        ...body,
        signature: nodeSign(null, Buffer.from(CommunitySuccession.canonicalBytes(body)), old.privateKey).toString(
          "base64url",
        ),
      }
      expect(yield* contacts.follow(statement)).toBe(true)

      // The address book shows ONE person, at their new key, still blocked and still named.
      const list = yield* contacts.list()
      expect(list.map((c) => c.networkID)).toEqual([newID])
      expect(list[0]!.petname).toBe("loud one")

      // 🔴 The old key still resolves to them — the whole point.
      expect((yield* contacts.get(oldID))?.networkID).toBe(newID)
      expect((yield* contacts.get(oldID))?.blocked).toBe(true)

      // And so the backlog is refused, exactly as a message at their current key is.
      expect(yield* channels.record(CHANNEL, backlog)).toEqual({ rejected: "blocked" })
      expect(yield* channels.record(CHANNEL, proven(signWith(fresh.privateKey, newID, "after")))).toEqual({
        rejected: "blocked",
      })
      expect(yield* channels.history(CHANNEL)).toEqual([])

      // Forgetting them forgets the CHAIN: a leftover old row would keep resolving to someone the
      // user believes is gone.
      expect(yield* contacts.forget(newID)).toBe(true)
      expect(yield* contacts.get(oldID)).toBeUndefined()
      expect(yield* contacts.list()).toEqual([])
    }),
  )


  it.effect("🔴 a peer who SPELLS the channel differently is in the SAME room", () =>
    Effect.gen(function* () {
      /**
       * `topic.ts` settled that `#NovaClaw` and `#novaclaw` are one channel, because a network with
       * no directory would never tell a user they were sitting alone in a room that looks right.
       * That rule lived only in the hashing, and the log compared channel names LITERALLY — so a
       * peer who typed the name differently had every message rejected as `wrong-channel`, on a
       * channel both sides are genuinely in.
       *
       * Nothing local could show it: the sender and receiver were always the same string. It takes a
       * message whose author spelled the room their own way.
       */
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)

      const theirSpelling = fromStranger({ channel: CHANNEL.toLowerCase(), body: "same room, other caps" })
      expect(theirSpelling.channel).not.toBe(CHANNEL)
      const result = yield* channels.record(CHANNEL, proven(theirSpelling))
      expect("stored" in result).toBe(true)
      expect((yield* channels.history(CHANNEL)).map((m) => m.body)).toEqual(["same room, other caps"])

      // ⚠️ And the guard it must NOT weaken: a different channel is still refused. Canonicalising
      // the comparison would be worthless if it also let `#elsewhere` through.
      expect(yield* channels.record(CHANNEL, proven(fromStranger({ channel: "#elsewhere", body: "no" })))).toEqual({
        rejected: "wrong-channel",
      })
    }),
  )

  it.effect("🔴 joining a channel you are already in under another spelling adds NO second room", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      // The user typed it differently the second time. One topic, so one room — and the spelling
      // they already had on screen is the one that survives.
      yield* channels.join(CHANNEL.toLowerCase())
      yield* channels.join(` ${CHANNEL} `)
      expect((yield* channels.channels()).map((entry) => entry.name)).toEqual([CHANNEL])

      // A genuinely different channel still joins.
      yield* channels.join("#recipes")
      expect((yield* channels.channels()).map((entry) => entry.name)).toEqual([CHANNEL, "#recipes"])
    }),
  )


  it.effect("🔴 leaving leaves the history REACHABLE, not just retained", () =>
    Effect.gen(function* () {
      /**
       * Principle 12: a setting may never require a value the user has no way to know. Leaving keeps
       * a channel's messages on purpose — and used to remove the only route back to them, so the way
       * to read your own history was to retype the name exactly, from memory. The room is not gone;
       * we are holding its messages.
       */
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      yield* channels.join("#recipes")
      yield* channels.record("#recipes", proven(fromStranger({ channel: "#recipes", body: "lavalamp" })))

      // While subscribed, it is a CHANNEL, never an archive entry.
      expect(yield* channels.archived()).toEqual([])

      expect(yield* channels.leave("#recipes")).toBe(true)
      expect(yield* channels.archived()).toEqual([{ name: "#recipes", messages: 1 }])
      // The messages are still there — leaving was never a delete.
      expect((yield* channels.history("#recipes")).map((m) => m.body)).toEqual(["lavalamp"])

      // Rejoining from the archive restores the room, and the archive no longer offers it.
      yield* channels.join("#recipes")
      expect((yield* channels.channels()).map((entry) => entry.name)).toEqual([CHANNEL, "#recipes"])
      expect(yield* channels.archived()).toEqual([])

      // ⚠️ And by TOPIC, not by name: rejoining under a different spelling is the SAME room, so the
      // old spelling must not be offered as somewhere else to go.
      yield* channels.leave("#recipes")
      yield* channels.join("#Recipes")
      expect(yield* channels.archived()).toEqual([])
    }),
  )


  it.effect("🔴 messages written under an EARLIER spelling of a room are not orphaned", () =>
    Effect.gen(function* () {
      /**
       * The room's identity is its canonical form everywhere — `topic.ts`, `join`, `verifyOn`. The
       * log was the exception: it stored the spelling of the channel row a message arrived on, and
       * read back by that literal string. Leave `#recipes`, rejoin as `#Recipes`, and everything
       * said before the rename is on disk and reachable from NOWHERE — not from history, which asks
       * for the new spelling, and not from the archive, which excludes it because it is correctly
       * the same room.
       */
      const channels = yield* CommunityChannels.Service
      yield* channels.join("#recipes")
      yield* channels.record("#recipes", proven(fromStranger({ channel: "#recipes", body: "before" })))
      yield* channels.leave("#recipes")

      yield* channels.join("#Recipes")
      yield* channels.record("#Recipes", proven(fromStranger({ channel: "#Recipes", body: "after" })))

      // One room, both messages, whichever spelling is used to ask.
      for (const spelling of ["#Recipes", "#recipes", "recipes"])
        expect((yield* channels.history(spelling)).map((m) => m.body).sort()).toEqual(["after", "before"])

      // And it is not ALSO offered as an archived room: the user is standing in it.
      expect(yield* channels.archived()).toEqual([])

      // Left entirely, it becomes ONE archive entry carrying BOTH messages — not two rooms the user
      // never made — named by the spelling they used most recently.
      yield* channels.leave("#Recipes")
      expect(yield* channels.archived()).toEqual([{ name: "#Recipes", messages: 2 }])
    }),
  )


  it.effect("🔴 leaving and muting accept ANY spelling of the room", () =>
    Effect.gen(function* () {
      /**
       * Found by leaving a room on the running instance and watching it stay: `DELETE #Recipes` while
       * joined as `#recipes` matched no row, changed nothing, and returned `false` — indistinguishable
       * from "you were not in that channel". `join`, `history` and `archived` had all been made
       * canonical; these two were still comparing strings.
       */
      const channels = yield* CommunityChannels.Service
      yield* channels.join("#recipes")

      expect(yield* channels.setMuted("#Recipes", true)).toBe(true)
      expect((yield* channels.channels()).map((c) => ({ name: c.name, muted: c.muted }))).toEqual([
        { name: "#recipes", muted: true },
      ])

      expect(yield* channels.leave("#RECIPES")).toBe(true)
      expect(yield* channels.channels()).toEqual([])

      // ⚠️ And still honest about a room we are genuinely not in.
      expect(yield* channels.leave("#never-joined")).toBe(false)
      expect(yield* channels.setMuted("#never-joined", true)).toBe(false)
    }),
  )

})
