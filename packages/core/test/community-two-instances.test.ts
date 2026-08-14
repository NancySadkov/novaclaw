import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
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
    LayerNode.group([InstanceIdentityStore.node, CommunityContacts.node, CommunityChannels.node]),
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
      // Alice signs, knowing nothing about Bob.
      const { message, aliceKey } = await Effect.runPromise(
        Effect.gen(function* () {
          const identity = yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))
          const signed = yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "hello from alice" })
          return { message: signed, aliceKey: identity.networkID }
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
    } finally {
      cleanup(alice.home)
      cleanup(bob.home)
    }
  })
})
