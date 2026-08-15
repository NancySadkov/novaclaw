import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { Offline } from "@novaclaw/core/offline"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"

/**
 * TWO instances, one message — the contract any transport must satisfy.
 *
 * 🔴 Every other community test drives ONE instance, which cannot show the thing the whole program
 * is for: that a stranger's words arrive, prove who wrote them, and land in a log. This wires two
 * separate databases together by hand, standing in for the transport that does not exist yet.
 *
 * When a transport lands, this is the test it has to pass — the only difference being that
 * `record` is called by the sidecar instead of by the test.
 */

const instance = (label: string) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `novaclaw-community-${label}-`))
  const file = path.join(home, "instance.db")
  // ⚠️ A distinct FILE per instance, not `:memory:`. Two in-memory databases built from the same
  // layer can silently collapse into one another's — and two instances that shared a database would
  // "exchange" messages by reading their own rows, proving nothing.
  const database = Database.layerFromPath(file)
  const graph = AppNodeBuilder.build(
    LayerNode.group([
      InstanceIdentityStore.node,
      CommunityContacts.node,
      CommunityChannels.node,
      Offline.node,
      CommunityTransport.node,
      CommunityPost.node,
    ]),
    [[Database.node, database]],
  )
  return { home, graph }
}

const cleanup = (home: string) => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* a locked SQLite file on Windows is not a test failure */
  }
}

describe("two instances", () => {
  test("🔴 a message crosses from one instance to another and is provably from its author", async () => {
    const alice = instance("alice")
    const bob = instance("bob")
    try {
      // Alice says something through the REAL send path, not by hand-signing. That is what a user
      // action actually runs, so it is what the contract has to cover: an earlier version signed
      // directly and never exercised `post` across instances at all.
      const { message, aliceKey } = await Effect.runPromise(
        Effect.gen(function* () {
          const identity = yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))
          const channels = yield* CommunityChannels.Service
          const posts = yield* CommunityPost.Service
          yield* channels.join("#NovaClaw")

          const posted = yield* posts.post("#NovaClaw", "hello from alice")
          // Stored on Alice's side even with nothing to carry it, and NOT delivered — the state
          // every install is in until a transport exists.
          expect(posted.stored).toBe(true)
          expect(posted.delivered).toBe(false)
          // And it is in her OWN log: a sender who cannot see what they said would assume it failed.
          expect((yield* channels.history("#NovaClaw")).map((m) => m.body)).toEqual(["hello from alice"])

          return { message: posted.message, aliceKey: identity.networkID }
        }).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      const seen = await Effect.runPromise(
        Effect.gen(function* () {
          const channels = yield* CommunityChannels.Service
          const bobKey = yield* InstanceIdentityStore.Service.pipe(
            Effect.flatMap((s) => s.identity()),
            Effect.map((i) => i.networkID),
          )
          // Two DIFFERENT identities, or the test is one instance talking to itself.
          expect(bobKey).not.toBe(aliceKey)

          yield* channels.join("#NovaClaw")
          // This call is the transport's whole job: hand what arrived to the one ingress door.
          const result = yield* channels.record("#NovaClaw", message)
          expect("stored" in result).toBe(true)

          return yield* channels.history("#NovaClaw")
        }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      expect(seen.map((m) => m.body)).toEqual(["hello from alice"])
      // Bob attributes it to Alice, having never met her: the signature is the introduction.
      expect(seen[0]?.author).toBe(aliceKey)
      expect(CommunityMessage.verify(seen[0]!)).toBe(true)

      // 🔴 And Bob rejects a forgery in Alice's name. Without this the test would pass on an
      // implementation that stored whatever arrived and believed the `author` field.
      const forged = { ...message, body: "alice never wrote this" }
      const refused = await Effect.runPromise(
        CommunityChannels.Service.pipe(
          Effect.flatMap((channels) => channels.record("#NovaClaw", forged)),
          Effect.provide(bob.graph),
          Effect.provide(CredentialCipher.defaultLayer),
        ),
      )
      expect(refused).toEqual({ rejected: "unverified" })

      /**
       * 🔴 REPLICATION: what Bob STORED must still be acceptable to a third instance.
       *
       * This is the defect the nonce column exists for. `Stored` used to extend `Signed`, dropping
       * the proof-of-work on the way into the database — so every message Bob relayed onward would
       * be refused as `unproven` by its receiver, while looking perfectly valid in Bob's own log.
       * Replication would have failed silently and completely, with each side blaming the other.
       */
      const relayed = seen[0]!
      expect(relayed.nonce).toBeGreaterThan(0)

      const carol = instance("carol")
      try {
        const accepted = await Effect.runPromise(
          Effect.gen(function* () {
            const channels = yield* CommunityChannels.Service
            yield* channels.join("#NovaClaw")
            // Exactly the bytes Bob holds, offered onward — the shape replication sends.
            return yield* channels.record("#NovaClaw", relayed)
          }).pipe(Effect.provide(carol.graph), Effect.provide(CredentialCipher.defaultLayer)),
        )
        expect("stored" in accepted).toBe(true)
      } finally {
        cleanup(carol.home)
      }
    } finally {
      cleanup(alice.home)
      cleanup(bob.home)
    }
  })
})
