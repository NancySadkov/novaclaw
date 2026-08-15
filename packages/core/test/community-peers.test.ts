import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P0 — the routing table peer exchange fills (`todo/community-p2p.md`).
 *
 * This table is the anti-shutdown property in storage, and it is also the ONE store an attacker can
 * grow without holding a key or paying any proof-of-work: they need only answer a peer-exchange
 * request with invented addresses. So these pin what it refuses as hard as what it keeps.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityContacts.node, CommunityPeers.node]),
  ),
)

const identity = (fill: number) => `nid_${Buffer.alloc(32, fill).toString("base64url")}`

describe("CommunityPeers", () => {
  it.effect("a peer is a ROUTE, and routes accumulate rather than replace", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      const peer = identity(1)
      expect(yield* peers.learn(peer, ["http://192.168.1.5:4096"], "lan")).toBe(true)
      // A LAN address and a public address are both true at once. Replacing would make whichever
      // source spoke last the only one that counts, and lose the route that actually works.
      yield* peers.learn(peer, ["https://example.org"], "px")

      const listed = yield* peers.list()
      expect(listed).toHaveLength(1)
      expect([...listed[0]!.routes].sort()).toEqual(["http://192.168.1.5:4096", "https://example.org"])
      // The SOURCE of the first sighting is kept: a bootstrap monoculture is only visible if you can
      // see where everything came from.
      expect(listed[0]!.source).toBe("lan")
    }),
  )

  it.effect("🔴 refuses our OWN identity, and anything that is not a public key", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      const store = yield* InstanceIdentityStore.Service
      const me = (yield* store.identity()).networkID

      // A table listing this instance makes it gossip with itself: every publish spends a round trip
      // talking into a mirror, and a "peer count" would include a peer that is us.
      expect(yield* peers.learn(me, ["http://127.0.0.1:4096"])).toBe(false)
      // An id that cannot verify a signature is an entry guaranteed to be useless — the same rule
      // the contact store enforces, for the same reason.
      expect(yield* peers.learn("not-a-key", ["http://example.org"])).toBe(false)
      expect(yield* peers.learn("nid_short", ["http://example.org"])).toBe(false)
      expect(yield* peers.list()).toEqual([])
    }).pipe(Effect.provide(InstanceIdentityStore.defaultLayer)),
  )

  it.effect("🔴 a BLOCKED peer is never handed to anyone who asks", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      const contacts = yield* CommunityContacts.Service
      const loud = identity(2)
      const fine = identity(3)
      yield* peers.learn(loud, ["http://loud.example"])
      yield* peers.learn(fine, ["http://fine.example"])

      yield* contacts.add({ networkID: loud, petname: "loud" }).pipe(Effect.orDie)
      yield* contacts.setBlocked(loud, true)

      // Blocking is the only power a user has here. An instance that still distributed a blocked
      // peer's address would be working for someone its owner refuses to hear.
      expect((yield* peers.sample()).map((peer) => peer.networkID)).toEqual([fine])
      // ⚠️ Still in OUR table: blocking decides what we pass on and what we accept, not what we know.
      expect((yield* peers.list()).map((peer) => peer.networkID).sort()).toEqual([loud, fine].sort())
    }),
  )

  it.effect("🔴 the table is BOUNDED — invented peers cost nothing to send", () =>
    Effect.gen(function* () {
      /**
       * The disk-fill vector with no key and no proof-of-work behind it: a peer answers one exchange
       * with thousands of invented addresses. Every other store here is guarded by a signature or by
       * work; this one cannot be, because the whole point is learning about strangers.
       */
      const peers = yield* CommunityPeers.Service
      const survivor = identity(200)
      yield* peers.learn(survivor, ["http://survivor.example"])
      yield* peers.seen(survivor)

      for (let index = 0; index < CommunityPeers.MAX_PEERS + 50; index++) {
        // 32 distinct bytes from an index, so each invented peer is a distinct valid-looking key.
        const key = Buffer.alloc(32)
        key.writeUInt32BE(index + 1, 0)
        yield* peers.learn(`nid_${key.toString("base64url")}`, [`http://invented-${index}.example`])
      }

      const listed = yield* peers.list()
      expect(listed.length).toBeLessThanOrEqual(CommunityPeers.MAX_PEERS)
      // ⚠️ Eviction is least-recently-SEEN first, so a peer that actually answered outlives the flood
      // that arrived after it. A bound that dropped the useful entry would be a denial of service
      // dressed as a limit.
      expect(listed.some((peer) => peer.networkID === survivor)).toBe(true)
    }),
  )

  it.effect("🔴 a ROTATED peer does not leave a second row for the same box", () =>
    Effect.gen(function* () {
      /**
       * Found by running the fresh-instance journey after a rotation, not by any unit test: one
       * machine appeared as TWO peers, its old identity and its new one, both at the same address.
       *
       * ⚠️ That is not untidiness. `reachable` de-duplicates by ROUTE, so only one of the pair is
       * ever dialled — and if it is the dead one, `seen` marks the wrong row alive, eviction keeps
       * the identity nobody answers as, and the working one ages out.
       */
      const peers = yield* CommunityPeers.Service
      const before = identity(11)
      const after = identity(12)
      const address = "http://192.168.1.50:4096"

      yield* peers.learn(before, [address], "px")
      expect((yield* peers.list()).map((peer) => peer.networkID)).toEqual([before])

      // The same box, answering under its new key after a rotation.
      yield* peers.learn(after, [address], "px")
      const listed = yield* peers.list()
      expect(listed.map((peer) => peer.networkID)).toEqual([after])
      expect([...listed[0]!.routes]).toEqual([address])

      // ⚠️ A DIFFERENT address is a different box and must survive — this must not become "the last
      // peer learned is the only peer".
      const elsewhere = identity(13)
      yield* peers.learn(elsewhere, ["http://10.0.0.9:4096"], "px")
      expect((yield* peers.list()).map((peer) => peer.networkID).sort()).toEqual([after, elsewhere].sort())
    }),
  )

})
