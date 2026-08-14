import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
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

describe("CommunityChannels", () => {
  it.effect("a joined channel records a verified message, and history reads it back", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      const message = yield* CommunityMessage.sign({ channel: CHANNEL, body: "hello" })

      const result = yield* channels.record(CHANNEL, message)
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
      expect(yield* channels.record(CHANNEL, message)).toEqual({ rejected: "not-subscribed" })

      yield* channels.join(CHANNEL)
      // Tampered: the signature no longer covers the body.
      expect(yield* channels.record(CHANNEL, { ...message, body: "edited" })).toEqual({ rejected: "unverified" })
      // Replayed from another channel onto this topic, signature perfectly valid.
      const elsewhere = yield* CommunityMessage.sign({ channel: "#elsewhere", body: "out of context" })
      expect(yield* channels.record(CHANNEL, elsewhere)).toEqual({ rejected: "wrong-channel" })

      // The honest one lands, and the SAME message arriving again from another mesh peer is a
      // duplicate rather than a second entry — the normal case in a gossip mesh.
      expect("stored" in (yield* channels.record(CHANNEL, message))).toBe(true)
      expect(yield* channels.record(CHANNEL, message)).toEqual({ rejected: "duplicate" })
      expect((yield* channels.history(CHANNEL)).length).toBe(1)
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
      expect(yield* channels.record(CHANNEL, message)).toEqual({ rejected: "blocked" })
      expect(yield* channels.history(CHANNEL)).toEqual([])
    }),
  )

  it.effect("🔴 history is ordered by RECEIVED time, not the author's claim", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)

      const honest = yield* CommunityMessage.sign({ channel: CHANNEL, body: "first", at: Date.now() })
      yield* channels.record(CHANNEL, honest)
      // A peer dating itself in the year 3000. Sorting by the claim would pin it above everyone
      // else's messages forever, in every reader's view, with no authority able to say otherwise.
      const liar = yield* CommunityMessage.sign({ channel: CHANNEL, body: "pinned", at: 32_503_680_000_000 })
      yield* channels.record(CHANNEL, liar)
      const later = yield* CommunityMessage.sign({ channel: CHANNEL, body: "latest", at: Date.now() })
      yield* channels.record(CHANNEL, later)

      const bodies = (yield* channels.history(CHANNEL)).map((m) => m.body)
      expect(bodies[0]).toBe("latest")
      expect(bodies).toEqual(["latest", "pinned", "first"])
    }),
  )

  it.effect("leaving keeps history — it is not a destructive act", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      yield* channels.join(CHANNEL)
      yield* channels.record(CHANNEL, yield* CommunityMessage.sign({ channel: CHANNEL, body: "kept" }))

      expect(yield* channels.leave(CHANNEL)).toBe(true)
      expect(yield* channels.channels()).toEqual([])
      // Rejoining must not show an empty room the user knows had messages.
      expect((yield* channels.history(CHANNEL)).map((m) => m.body)).toEqual(["kept"])
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
