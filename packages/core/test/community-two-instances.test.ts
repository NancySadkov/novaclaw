import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { CommunityTopic } from "@novaclaw/core/community/topic"
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
      CommunityPeers.node,
      CommunitySync.node,
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

  test("🔴 a message crosses over a REAL HTTP socket, dialled by the transport", async () => {
    /**
     * P2's stated deliverable: the two-instance test over a real network. Everything before this
     * handed Bob the message by calling his ingress door directly, which proves the door and nothing
     * about the wire — the transport was a null implementation returning `false`.
     *
     * Bob here is a real HTTP server on a real port. Alice's transport discovers him the only way it
     * ever will (a contact with an `http://` route), addresses him by TOPIC rather than by channel
     * name, and POSTs. Nothing in the test tells Alice where to send: it is read from her contacts.
     */
    const alice = instance("alice-http")
    const bob = instance("bob-http")
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const bobDelivered: unknown[] = []
      // Stands in for the instance's `communityInbound` route, doing exactly what it does: hand the
      // payload to the ONE ingress door and answer uniformly, disclosing no verdict.
      server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const body = (await request.json()) as { topic: string; message: CommunityMessage.Proven }
          bobDelivered.push(body.topic)
          await Effect.runPromise(
            Effect.gen(function* () {
              const channels = yield* CommunityChannels.Service
              yield* channels.deliver(body.topic, body.message)
            }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
          )
          return Response.json({ received: true })
        },
      })
      const bobURL = `http://127.0.0.1:${server.port}`
      // Bob's REAL key: a contact is an identity plus routes, and `add` refuses an id that is not a
      // public key — so a placeholder would fail the very check that makes contacts meaningful.
      const bobKey = await Effect.runPromise(
        InstanceIdentityStore.Service.pipe(
          Effect.flatMap((store) => store.identity()),
          Effect.map((identity) => identity.networkID),
        ).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      const aliceKey = await Effect.runPromise(
        Effect.gen(function* () {
          const contacts = yield* CommunityContacts.Service
          const channels = yield* CommunityChannels.Service
          const posts = yield* CommunityPost.Service
          const transport = yield* CommunityTransport.Service
          const identity = yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))

          yield* channels.join("#NovaClaw")
          // Before Alice knows anybody reachable: the transport works and has nowhere to send.
          expect(yield* transport.state()).toEqual({ kind: "off", reason: "no-peers" })

          yield* contacts.add({ networkID: bobKey, petname: "bob", routes: [bobURL] })
          expect(yield* transport.state()).toEqual({ kind: "online", peers: 1 })

          /**
           * 🔴 First, to a Bob who has NOT joined the channel. `delivered` is true — he took the
           * bytes — and he stores nothing, because a topic is a hash he cannot invert and nothing he
           * subscribes to has that id. The rule holds by arithmetic across the wire, not by trusting
           * the sender, and it is worth pinning that "the peer answered" never means "the peer kept
           * it".
           */
          const ignored = yield* posts.post("#NovaClaw", "before bob joined")
          expect(ignored.delivered).toBe(true)

          return identity.networkID
        }).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      const ignoredByBob = await Effect.runPromise(
        CommunityChannels.Service.pipe(
          Effect.flatMap((channels) => channels.history("#NovaClaw")),
        ).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )
      expect(ignoredByBob).toEqual([])

      // Now Bob joins, and Alice says something else. Nothing about Alice changes.
      await Effect.runPromise(
        CommunityChannels.Service.pipe(Effect.flatMap((channels) => channels.join("#NovaClaw"))).pipe(
          Effect.provide(bob.graph),
          Effect.provide(CredentialCipher.defaultLayer),
        ),
      )
      await Effect.runPromise(
        CommunityPost.Service.pipe(
          Effect.flatMap((posts) => posts.post("#NovaClaw", "over the wire")),
          Effect.tap((posted) => Effect.sync(() => expect(posted.delivered).toBe(true))),
        ).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      const seen = await Effect.runPromise(
        Effect.gen(function* () {
          const channels = yield* CommunityChannels.Service
          return yield* channels.history("#NovaClaw")
        }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      // Bob has it, attributed to Alice, whom he has never met — over a socket.
      expect(seen.map((m) => m.body)).toEqual(["over the wire"])
      expect(seen[0]?.author).toBe(aliceKey)
      expect(CommunityMessage.verify(seen[0]!)).toBe(true)
      // ⚠️ Addressed by TOPIC: the hash, never the channel name, so a peer spelling the room
      // differently still resolves it and a peer who never joined it cannot store it at all.
      expect(bobDelivered).toEqual([CommunityTopic.topicOf("#NovaClaw"), CommunityTopic.topicOf("#NovaClaw")])
    } finally {
      server?.stop(true)
      cleanup(alice.home)
      cleanup(bob.home)
    }
  })


  test("🔴 an instance that was AWAY catches up on what it missed", async () => {
    /**
     * The largest design risk in the program, finally exercised. Delivery reaches whoever is ONLINE,
     * so an instance that was closed misses that time permanently — and a forum whose messages vanish
     * for anyone who was away is not a forum. `reconcile.ts` has held the algorithm since it was
     * written and had no wire; this is the wire.
     *
     * Bob talks while Alice is not listening. Alice then reconciles against him and ends up holding
     * everything, having asked for precisely what she lacked.
     */
    const alice = instance("alice-sync")
    const bob = instance("bob-sync")
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const said = ["one", "two", "three", "four", "five"]
      const bobKey = await Effect.runPromise(
        Effect.gen(function* () {
          const channels = yield* CommunityChannels.Service
          const posts = yield* CommunityPost.Service
          const identity = yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((store) => store.identity()))
          yield* channels.join("#NovaClaw")
          // Bob's log, built while Alice knows nothing about it.
          for (const body of said) yield* posts.post("#NovaClaw", body)
          return identity.networkID
        }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      // Bob serves the three catch-up steps, exactly as the instance's peer routes do.
      const asked: string[] = []
      server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          asked.push(url.pathname)
          const body = (await request.json()) as { topic: string; buckets?: number[]; ids?: string[] }
          const answer = await Effect.runPromise(
            Effect.gen(function* () {
              const channels = yield* CommunityChannels.Service
              const joined = yield* channels.channels()
              const room = CommunityTopic.channelFor(
                body.topic,
                joined.map((entry) => entry.name),
              )
              // ⚠️ An unknown topic answers like an EMPTY ROOM — `summarize([])`, 64 empty digests —
              // never a shorter body. A peer must not be able to tell "not subscribed" from "nothing
              // said here" by counting buckets, which is how the real handler was caught getting it
              // wrong against a comment claiming otherwise.
              const ids = room === undefined ? [] : yield* channels.ids(room)
              if (url.pathname === CommunitySync.SYNC_SUMMARY_PATH)
                return { buckets: CommunityReconcile.summarize(ids) }
              if (url.pathname === CommunitySync.SYNC_IDS_PATH)
                return { ids: CommunityReconcile.idsIn(ids, body.buckets ?? []) }
              // Same rule for the message step: an unjoined room yields nothing, not an error.
              return { messages: room === undefined ? [] : yield* channels.byIDs(room, body.ids ?? []) }
            }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
          )
          return Response.json(answer)
        },
      })

      const caught = await Effect.runPromise(
        Effect.gen(function* () {
          const channels = yield* CommunityChannels.Service
          const contacts = yield* CommunityContacts.Service
          const sync = yield* CommunitySync.Service
          yield* channels.join("#NovaClaw")
          yield* contacts
            .add({ networkID: bobKey, petname: "bob", routes: [`http://127.0.0.1:${server!.port}`] })
            .pipe(Effect.orDie)

          // She has nothing, and received none of it — she was away.
          expect(yield* channels.history("#NovaClaw")).toEqual([])

          expect(yield* sync.sync("#NovaClaw")).toEqual({ peers: 1, fetched: said.length })
          return yield* channels.history("#NovaClaw")
        }).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      expect(caught.map((message) => message.body).sort()).toEqual([...said].sort())
      // Every one attributed to Bob and verified from its signature — she never met him before today.
      expect(new Set(caught.map((message) => message.author))).toEqual(new Set([bobKey]))

      /**
       * 🔴 Syncing again fetches NOTHING, and — the claim that actually justifies the design — stops
       * after the SUMMARY. Two instances that agree exchange ~4 KB whatever their logs hold.
       *
       * ⚠️ Asserted on the round trips, not only on the count. A sync that re-downloaded everything
       * and discarded it as duplicates would also report `fetched: 0`, look correct, and cost the
       * ~320 KB per channel that bucketing exists to avoid. Verified by breaking `differing` to claim
       * every bucket disagrees: the counts stay right and this assertion is what fails.
       */
      asked.length = 0
      const again = await Effect.runPromise(
        CommunitySync.Service.pipe(
          Effect.flatMap((sync) => sync.sync("#NovaClaw")),
          Effect.provide(alice.graph),
          Effect.provide(CredentialCipher.defaultLayer),
        ),
      )
      expect(again).toEqual({ peers: 1, fetched: 0 })
      expect(asked).toEqual([CommunitySync.SYNC_SUMMARY_PATH])
    } finally {
      server?.stop(true)
      cleanup(alice.home)
      cleanup(bob.home)
    }
  })


  test("🔴 ONE address reaches a peer we were never told about — peer exchange", async () => {
    /**
     * The anti-shutdown property, exercised rather than asserted. The spec states it exactly: *any
     * peer address from any source is a complete entry point, because PEER EXCHANGE supplies the
     * rest. There is no list to seize, because there is nothing special about any particular entry.*
     *
     * Alice is given exactly one address — Bob's. Bob knows Carol. Alice must end up able to reach
     * Carol, whom nobody told her about, WITHOUT Carol becoming a contact: an address book is a trust
     * decision the user makes, and a peer that can talk to us must never be able to write itself into
     * it. That is why `observe` and `follow` refuse to create entries, and why this lands elsewhere.
     */
    const alice = instance("alice-px")
    const bob = instance("bob-px")
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const carol = `nid_${Buffer.alloc(32, 9).toString("base64url")}`
      const carolRoute = "http://198.51.100.7:4096"

      // Bob knows Carol — as a PEER, the way peer exchange would have taught him.
      const bobKey = await Effect.runPromise(
        Effect.gen(function* () {
          const peers = yield* CommunityPeers.Service
          expect(yield* peers.learn(carol, [carolRoute], "px")).toBe(true)
          return (yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((store) => store.identity()))).networkID
        }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      server = Bun.serve({
        port: 0,
        fetch: async () =>
          Response.json(
            await Effect.runPromise(
              CommunityPeers.Service.pipe(
                Effect.flatMap((peers) => peers.sample()),
                Effect.map((offered) => ({
                  peers: offered.map((peer) => ({ networkID: peer.networkID, routes: peer.routes })),
                })),
                Effect.provide(bob.graph),
                Effect.provide(CredentialCipher.defaultLayer),
              ),
            ),
          ),
      })

      const seen = await Effect.runPromise(
        Effect.gen(function* () {
          const contacts = yield* CommunityContacts.Service
          const peers = yield* CommunityPeers.Service
          const sync = yield* CommunitySync.Service

          // Everything Alice is given: one address.
          yield* contacts
            .add({ networkID: bobKey, petname: "bob", routes: [`http://127.0.0.1:${server!.port}`] })
            .pipe(Effect.orDie)
          expect(yield* peers.list()).toEqual([])

          expect(yield* sync.discover()).toEqual({ asked: 1, learned: 1 })

          // 🔴 Carol is now reachable, and is NOT in the address book. Both halves matter.
          expect((yield* contacts.list()).map((entry) => entry.networkID)).toEqual([bobKey])

          /**
           * 🔴 And the TRANSPORT can reach her. Found by running it: discovery filled the peer table
           * while `state()` still said `no-peers`, because publishing only ever consulted contacts —
           * so the network could be discovered and not spoken to, which makes peer exchange
           * pointless, everything it learns landing in the peer table by design.
           */
          const transport = yield* CommunityTransport.Service
          // ⚠️ TWO reachable identities (Bob and Carol), not a count of routes: one instance with a
          // LAN address and a loopback address is one peer, and saying "2" would invent a stranger.
          expect(yield* transport.state()).toEqual({ kind: "online", peers: 2 })
          return yield* peers.list()
        }).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      expect(seen.map((peer) => ({ id: peer.networkID, routes: [...peer.routes] }))).toEqual([
        { id: carol, routes: [carolRoute] },
      ])
    } finally {
      server?.stop(true)
      cleanup(alice.home)
      cleanup(bob.home)
    }
  })

})
