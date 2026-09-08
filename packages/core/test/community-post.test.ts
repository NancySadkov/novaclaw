import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityPost } from "@novaclaw/core/community/post"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { Offline } from "@novaclaw/core/offline"
import { testEffect } from "./lib/effect"

/**
 * Community P4 — saying something (`notes/spec/community-p2p.md`).
 *
 * The counterpart to `record`. What matters here is what happens when there is nowhere to send: a
 * user's own words must survive a missing transport, because that is every install today.
 */

const it = testEffect(
  LayerNode.compile(
    // Channels is listed explicitly as well as being a dependency of Post: these cases read the log
    // directly, and a service that is only a transitive dep is not in scope for the test.
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      Offline.node,
      CommunityChannels.node,
      CommunityPost.node,
    ]),
  ),
)

const CHANNEL = CommunityChannels.DEFAULT_CHANNEL

describe("CommunityPost", () => {
  it.effect("🔴 a post is KEPT even though nothing can deliver it", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      const posts = yield* CommunityPost.Service
      yield* channels.join(CHANNEL)

      const result = yield* posts.post(CHANNEL, "first words")
      // Stored before any send is attempted, so a missing transport costs an AUDIENCE and never the
      // message. Losing it would happen exactly when the network failed — when a person is least
      // able to retype it.
      expect(result.stored).toBe(true)
      expect(result.delivered).toBe(false)

      const history = yield* channels.history(CHANNEL)
      expect(history.map((m) => m.body)).toEqual(["first words"])
      // And it is a real signed message, indistinguishable to a peer from any other.
      expect(CommunityMessage.verify(result.message)).toBe(true)
      expect(result.message.author).toBe(
        (yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))).networkID,
      )
    }),
  )

  it.effect("🔴 posting to a channel we never joined is REFUSED, not silently logged", () =>
    Effect.gen(function* () {
      const posts = yield* CommunityPost.Service
      const channels = yield* CommunityChannels.Service

      // Our own message goes through the same ingress door as a stranger's, so the same rule
      // applies: no subscription, no log. A private insert path would have quietly created a
      // channel nobody is listening to.
      const result = yield* posts.post("#never-joined", "into nowhere")
      expect(result.stored).toBe(false)
      expect(result.delivered).toBe(false)
      expect(yield* channels.history("#never-joined")).toEqual([])
    }),
  )

  it.effect("🔴 two posts of the SAME words in one millisecond collide — a known edge", () =>
    Effect.gen(function* () {
      const channels = yield* CommunityChannels.Service
      const posts = yield* CommunityPost.Service
      yield* channels.join(CHANNEL)

      // The dedup id is a hash of the signed bytes, and `at` is millisecond-resolution — so identical
      // words posted inside one millisecond hash identically and the second reads as a duplicate.
      // Recorded rather than hidden: it is invisible to a human typing, and it becomes real the day
      // something posts programmatically in a loop.
      const first = yield* posts.post(CHANNEL, "same breath")
      const second = yield* posts.post(CHANNEL, "same breath")
      expect(first.stored).toBe(true)

      const stored = yield* channels.history(CHANNEL)
      // Either outcome is CORRECT depending on which millisecond they landed in; what must hold is
      // that the log and the report agree, never that a post claims to be stored and is not there.
      expect(stored.length).toBe(second.stored ? 2 : 1)
    }),
  )
})
