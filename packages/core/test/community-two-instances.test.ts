import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunitySeal } from "@novaclaw/core/community/seal"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
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
      CommunityDirect.node,
      Offline.node,
      CommunityTransport.node,
      CommunityPeers.node,
      CommunitySearch.node,
      CommunitySuccession.node,
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


  test("🔴 a peer that was OFFLINE when someone rotated still finds them", async () => {
    /**
     * The reason rotation stayed unexposed until a transport existed: *a successor statement no peer
     * can receive would strand the user.* Pushing one reaches whoever is online at that instant,
     * which in a network of home machines is a minority — so a push-only design strands the user
     * against everybody who happened to be closed, which is the majority.
     *
     * Carol is that majority. Nobody ever tells her anything; she asks Bob later and finds Alice.
     */
    const alice = instance("alice-rot")
    const bob = instance("bob-rot")
    const carol = instance("carol-rot")
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      const rotation = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* InstanceIdentityStore.Service
          const before = (yield* store.identity()).networkID
          const rotated = yield* store.rotate()
          return { before, after: rotated.identity.networkID, statement: rotated.statement }
        }).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )
      expect(rotation.after).not.toBe(rotation.before)

      // Bob was ONLINE: he hears it directly and follows.
      const bobKey = await Effect.runPromise(
        Effect.gen(function* () {
          const contacts = yield* CommunityContacts.Service
          const successions = yield* CommunitySuccession.Store
          const store = yield* InstanceIdentityStore.Service
          yield* contacts.add({ networkID: rotation.before, petname: "alice" }).pipe(Effect.orDie)
          expect(yield* successions.remember(rotation.statement)).toBe(true)
          expect(yield* contacts.followAll([rotation.statement])).toBe(1)
          expect((yield* contacts.list()).map((entry) => entry.networkID)).toEqual([rotation.after])
          return (yield* store.identity()).networkID
        }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      // Bob re-serves what he was told. Storing it is what makes him able to.
      server = Bun.serve({
        port: 0,
        fetch: async () =>
          Response.json(
            await Effect.runPromise(
              CommunitySuccession.Store.pipe(
                Effect.flatMap((store) => store.known()),
                Effect.map((statements) => ({ statements })),
                Effect.provide(bob.graph),
                Effect.provide(CredentialCipher.defaultLayer),
              ),
            ),
          ),
      })

      const landed = await Effect.runPromise(
        Effect.gen(function* () {
          const contacts = yield* CommunityContacts.Service
          const sync = yield* CommunitySync.Service
          // Carol knew Alice at the old key too, and was CLOSED when the rotation happened.
          yield* contacts.add({ networkID: rotation.before, petname: "alice" }).pipe(Effect.orDie)
          yield* contacts
            .add({ networkID: bobKey, petname: "bob", routes: [`http://127.0.0.1:${server!.port}`] })
            .pipe(Effect.orDie)

          const spread = yield* sync.successions()
          expect(spread.learned).toBe(1)
          return (yield* contacts.list()).map((entry) => entry.networkID)
        }).pipe(Effect.provide(carol.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      // 🔴 Carol followed Alice without ever being told: she asked, and the statement proved itself.
      expect(landed).toContain(rotation.after)
      expect(landed).not.toContain(rotation.before)
    } finally {
      server?.stop(true)
      cleanup(alice.home)
      cleanup(bob.home)
      cleanup(carol.home)
    }
  })


  test("🔴 a channel is found TWO HOPS away, through a peer that does not have it", async () => {
    /**
     * The owner's decision, exercised: *search is done through selective request-count throttled
     * broadcast — no central servers, just nodes, and once a user found a single living node they
     * can join the network.*
     *
     * Alice knows only Bob. Bob does not have the channel; Carol does, and Alice has never heard of
     * her. If this only reached directly-connected instances it would find nothing — which is
     * exactly what the one-hop `nearby` list already does, and why this is a different mechanism.
     */
    const alice = instance("alice-search")
    const bob = instance("bob-search")
    const carol = instance("carol-search")
    let bobServer: ReturnType<typeof Bun.serve> | undefined
    let carolServer: ReturnType<typeof Bun.serve> | undefined
    try {
      const serve = (who: typeof bob) =>
        Bun.serve({
          port: 0,
          fetch: async (request) => {
            const query = (await request.json()) as CommunitySearch.Query
            return Response.json(
              await Effect.runPromise(
                CommunitySearch.Service.pipe(
                  Effect.flatMap((search) => search.receive(query)),
                  Effect.map((channels) => ({ channels })),
                  Effect.provide(who.graph),
                  Effect.provide(CredentialCipher.defaultLayer),
                ),
              ),
            )
          },
        })

      // Carol is in a channel and LISTS it — unlisted, she would be invisible to any search.
      carolServer = serve(carol)
      const carolKey = await Effect.runPromise(
        Effect.gen(function* () {
          const channels = yield* CommunityChannels.Service
          const store = yield* InstanceIdentityStore.Service
          yield* channels.join("#bread-baking")
          expect(yield* channels.setListed("#bread-baking", true)).toBe(true)
          return (yield* store.identity()).networkID
        }).pipe(Effect.provide(carol.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      // Bob knows Carol and does NOT have the channel himself.
      bobServer = serve(bob)
      const bobKey = await Effect.runPromise(
        Effect.gen(function* () {
          const peers = yield* CommunityPeers.Service
          const store = yield* InstanceIdentityStore.Service
          yield* peers.learn(carolKey, [`http://127.0.0.1:${carolServer!.port}`], "px")
          return (yield* store.identity()).networkID
        }).pipe(Effect.provide(bob.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      const found = await Effect.runPromise(
        Effect.gen(function* () {
          const peers = yield* CommunityPeers.Service
          const search = yield* CommunitySearch.Service
          // Everything Alice knows: one address, Bob's.
          yield* peers.learn(bobKey, [`http://127.0.0.1:${bobServer!.port}`], "px")
          return yield* search.search("bread")
        }).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      // 🔴 Found through Bob, who does not have it — the hop that makes this a broadcast rather than
      // a directory lookup.
      expect(found).toEqual(["#bread-baking"])

      // ⚠️ And an UNLISTED channel stays invisible however hard anyone searches: discovery must not
      // become the door that undoes the disclosure the user never gave.
      await Effect.runPromise(
        CommunityChannels.Service.pipe(
          Effect.flatMap((channels) => channels.setListed("#bread-baking", false)),
          Effect.provide(carol.graph),
          Effect.provide(CredentialCipher.defaultLayer),
        ),
      )
      const hidden = await Effect.runPromise(
        CommunitySearch.Service.pipe(
          Effect.flatMap((search) => search.search("bread")),
          Effect.provide(alice.graph),
          Effect.provide(CredentialCipher.defaultLayer),
        ),
      )
      expect(hidden).toEqual([])
    } finally {
      bobServer?.stop(true)
      carolServer?.stop(true)
      cleanup(alice.home)
      cleanup(bob.home)
      cleanup(carol.home)
    }
  })


  test("🔴 a direct message is readable ONLY by its recipient — not by the relay carrying it", async () => {
    /**
     * §11 said a DM needed no encryption because the transport encrypted to the peer's KEY. Ours
     * encrypts to an ADDRESS, and relaying through instances is the answer for unreachable peers — so
     * without this layer the relay reads everything, which is the case the relay exists to serve.
     *
     * Mallory here IS that relay: she holds the exact bytes that crossed the wire.
     */
    const alice = instance("alice-dm")
    const bob = instance("bob-dm")
    const mallory = instance("mallory-dm")
    try {
      /**
       * ⚠️ Generic over the REQUIREMENT, with one cast where the graph satisfies it. The first version
       * declared `never` there, which does not describe any of these effects — every block needs some
       * service — and the compiler was right to refuse. The cast asserts exactly what is true and is
       * confined to this line, rather than an `as never` at each call site hiding what each one needs.
       */
      const run = <A, R>(who: { graph: typeof alice.graph }, effect: Effect.Effect<A, never, R>) =>
        Effect.runPromise(
          effect.pipe(Effect.provide(who.graph), Effect.provide(CredentialCipher.defaultLayer)) as Effect.Effect<A>,
        )

      // Bob publishes a sealing key, signed by his identity — what `/global/health` serves.
      const bobPublished = await run(
        bob,
        Effect.gen(function* () {
          const store = yield* InstanceIdentityStore.Service
          const self = yield* store.identity()
          const sealing = yield* store.sealingKey()
          return { networkID: self.networkID, ...sealing }
        }),
      )

      const onTheWire = await run(
        alice,
        Effect.gen(function* () {
          const direct = yield* CommunityDirect.Service
          const composed = yield* direct.compose({
            to: bobPublished.networkID,
            sealingKey: bobPublished.publicKey,
            sealingSignature: bobPublished.signature,
            body: "the vote is on thursday",
          })
          expect("message" in composed).toBe(true)
          if (!("message" in composed)) throw new Error("compose refused")
          // ⚠️ Alice keeps her OWN plaintext: she can never recover it from the envelope, because the
          // ephemeral key that sealed it is gone. That is the forward secrecy, not a leak.
          expect(composed.stored.body).toBe("the vote is on thursday")
          expect(composed.stored.direction).toBe("out")
          return composed.message
        }),
      )

      // 🔴 The plaintext is nowhere in what crossed the wire.
      expect(JSON.stringify(onTheWire)).not.toContain("thursday")

      // Mallory relays it. She is a full NovaClaw instance holding the real bytes, and gets nothing:
      // not the text, and not a stored message either.
      const relayed = await run(mallory, CommunityDirect.Service.pipe(Effect.flatMap((d) => d.receive(onTheWire))))
      expect(relayed).toEqual({ rejected: "not-for-us" })

      const seen = await run(
        bob,
        Effect.gen(function* () {
          const direct = yield* CommunityDirect.Service
          const result = yield* direct.receive(onTheWire)
          expect("stored" in result).toBe(true)
          return yield* direct.history(bobPublished.networkID === "" ? "" : (onTheWire.from as string))
        }),
      )
      expect(seen.map((message) => message.body)).toEqual(["the vote is on thursday"])
      expect(seen[0]?.direction).toBe("in")

      // Delivered twice — the ordinary case when a sender retries — stores once.
      const again = await run(bob, CommunityDirect.Service.pipe(Effect.flatMap((d) => d.receive(onTheWire))))
      expect(again).toEqual({ rejected: "duplicate" })

      /**
       * 🔴 A SUBSTITUTED sealing key is refused before anything is sealed to it.
       *
       * ⚠️ This case was MISSING when the test was first written, and its absence was invisible: with
       * the verification deleted the rest of this test still passed, because everything else here
       * hands over a genuine key. That is exactly the attack's nature — a substituted key produces
       * valid ciphertext and a successful send, so the only thing that can notice is a check nobody
       * exercised. Found by removing the check and watching the suite stay green.
       */
      const attacker = CommunitySeal.generate()
      const substituted = await run(
        alice,
        CommunityDirect.Service.pipe(
          Effect.flatMap((direct) =>
            direct.compose({
              to: bobPublished.networkID,
              // Mallory's key, offered in Bob's name, with Bob's real signature attached.
              sealingKey: attacker.publicKey,
              sealingSignature: bobPublished.signature,
              body: "should never be sealed to an attacker",
            }),
          ),
        ),
      )
      expect(substituted).toEqual({ rejected: "unverified" })

      // ⚠️ And a TAMPERED envelope is refused: the signature covers the sealed parts, so swapping the
      // ciphertext cannot keep the author's name on it.
      const tampered = { ...onTheWire, sealed: { ...onTheWire.sealed, ct: "AAAA" } }
      expect(await run(bob, CommunityDirect.Service.pipe(Effect.flatMap((d) => d.receive(tampered))))).toEqual({
        rejected: "unverified",
      })
    } finally {
      cleanup(alice.home)
      cleanup(bob.home)
      cleanup(mallory.home)
    }
  })


  test("🔴 a peer answering with a MILLION invented ids cannot make us chase them", async () => {
    /**
     * The asker pays for the answerer's claim. Reconciliation asks a peer which ids it holds and then
     * fetches what it lacks — so a hostile answer of a million invented ids costs the peer ONE
     * response and costs us thousands of round trips plus the array to hold them.
     *
     * ⚠️ Nothing bad would be STORED — every fetched message still passes the ingress door. The cost
     * is the chase itself, which is the same asymmetry the peer table's bound and the message-size
     * bound already close.
     */
    const alice = instance("alice-flood")
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      let idsRequests = 0
      let messageRequests = 0
      server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          if (url.pathname === CommunitySync.SYNC_SUMMARY_PATH) {
            // Every bucket differs, so the asker asks for ids.
            return Response.json({ buckets: Array.from({ length: 64 }, (_, index) => `deadbeef${index}`) })
          }
          if (url.pathname === CommunitySync.SYNC_IDS_PATH) {
            idsRequests++
            // A million ids nobody holds. Cheap to generate, expensive to chase.
            return Response.json({ ids: Array.from({ length: 1_000_000 }, (_, index) => index.toString(16).padStart(64, "0")) })
          }
          messageRequests++
          return Response.json({ messages: [] })
        },
      })

      const bobKey = `nid_${Buffer.alloc(32, 5).toString("base64url")}`
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const channels = yield* CommunityChannels.Service
          const peers = yield* CommunityPeers.Service
          const sync = yield* CommunitySync.Service
          yield* channels.join("#NovaClaw")
          yield* peers.learn(bobKey, [`http://127.0.0.1:${server!.port}`], "px")
          return yield* sync.sync("#NovaClaw")
        }).pipe(Effect.provide(alice.graph), Effect.provide(CredentialCipher.defaultLayer)),
      )

      expect(result.fetched).toBe(0)
      expect(idsRequests).toBe(1)
      // 🔴 The chase is bounded by our own retention, not by what the peer claimed: at 256 ids a
      // request, a million would have been ~3,900 round trips.
      expect(messageRequests).toBeLessThanOrEqual(
        Math.ceil(CommunityChannels.RETAIN_PER_CHANNEL / CommunitySync.MAX_MESSAGES_PER_REQUEST),
      )
    } finally {
      server?.stop(true)
      cleanup(alice.home)
    }
  })

})
