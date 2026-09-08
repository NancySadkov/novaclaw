import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"
import { mintIdentity } from "./lib/community"

/**
 * Community P0 — the routing table peer exchange fills (`notes/spec/community-p2p.md`).
 *
 * This table is the anti-shutdown property in storage, and it is also the ONE store an attacker can
 * grow without holding a key or paying any proof-of-work: they need only answer a peer-exchange
 * request with invented addresses. So these pin what it refuses as hard as what it keeps.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityContacts.node,
      CommunityObservation.node,
      CommunityPeers.node,
    ]),
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

      yield* peers.learn(before, [address], "lan")
      expect((yield* peers.list()).map((peer) => peer.networkID)).toEqual([before])

      /**
       * The same box, answering under its new key after a rotation.
       *
       * ⚠️ A DIALLED source, and after 2026-08-17 (review 1.5) that is the whole condition. This
       * rule is sound about a route that ANSWERED us; applied to hearsay it let any peer-exchange
       * answer delete a verified row and re-insert it with a new introducer, rewriting the doorman
       * edge AGENTS.md relies on to tell a cluster from a consensus. The cost of the restriction is
       * named rather than hidden: a rotation learned ONLY through hearsay leaves both rows until one
       * of them is dialled. `community-reach.test.ts` pins that direction.
       */
      yield* peers.learn(after, [address], "lan")
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

  test("🔴 one sync operation reaches a BOUNDED number of peers", () => {
    /**
     * The seventh finding surviving in the paths its fix never reached. `transport.publish` and
     * `search.broadcast` cap fan-out at 8; every loop in `sync.ts` walked the whole table.
     *
     * ⚠️ Worse than a socket storm, because those loops are SEQUENTIAL with an 8 s per-peer timeout:
     * a table filled to its allowed 500 turns one press of "look for instances" into up to 66
     * minutes of waiting, and a user action that never returns is a frozen app. Nothing a stranger
     * sent was wrong — they only had to be REACHABLE, which is what peer exchange is for.
     *
     * ⚠️ **A SOURCE check, and the weaker kind on purpose.** My first version asserted only that the
     * constant existed and was sane — it passed with the cap deleted, which is no test at all.
     * Exercising the real sweep needs sixty dials to fail before anything can be counted, and a test
     * that takes minutes to restate a number is one nobody runs. This reads the one line that makes
     * the number bind.
     */
    const source = readFileSync(new URL("../src/community/sync.ts", import.meta.url), "utf8")
    const reachable = source.slice(source.indexOf("const reachable = Effect.gen"))
    const body = reachable.slice(0, reachable.indexOf("\n    })"))

    /**
     * ⚠️ The shape moved when the dial list gained ONE builder (review 1.9): the cap is now the
     * `limit` the shared `CommunityReach.reachable` applies after de-duplication, rather than a
     * slice written out here. Both halves are asserted — the call and the constant — so the number
     * still cannot be deleted or quietly replaced with a literal.
     */
    expect(body).toContain("CommunityReach.reachable(")
    expect(body).toContain("limit: MAX_PEERS_ASKED")
    /**
     * The cap must be the LAST thing that happens to the list — slicing before de-duplication would
     * count spellings of one box rather than distinct boxes. That ordering moved into the shared
     * builder with the list itself, so it is asserted where it now lives.
     */
    const reach = readFileSync(new URL("../src/community/reach.ts", import.meta.url), "utf8")
    expect(reach.indexOf("out.slice(0, input.limit)")).toBeGreaterThan(reach.indexOf("already.add(route)"))
    expect(CommunitySync.MAX_PEERS_ASKED).toBeLessThanOrEqual(32)
  })

  it.effect("🔴 one px claim cannot put an unbounded address list on a peer", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      const target = `nid_${Buffer.alloc(32, 9).toString("base64url")}`

      /**
       * Peer exchange is hearsay — `learn` refuses an unparseable key and our own, and nothing else
       * — so this list is a stranger's number. Measured before the cap: 5,000 routes on one row.
       *
       * ⚠️ The damage is not the row, it is the LOOP it feeds. `reachable` slices its own dialling,
       * but `sendDirect` builds its address list separately and walks every one at a 10 s timeout,
       * so this number decided how long the USER's own private message took to fail.
       */
      const flood = Array.from({ length: 5000 }, (_, i) => `http://10.0.0.1:${1000 + i}`)
      yield* peers.learn(target, flood, "px")
      const stored = (yield* peers.list()).find((entry) => entry.networkID === target)?.routes ?? []
      expect(stored.length).toBe(CommunityPeers.MAX_ROUTES_PER_PEER)

      /**
       * 🔴 And the cap keeps the NEWEST, which is the half a naive slice gets backwards: keeping the
       * oldest would drop exactly the address that repairs a peer who has moved — the case these
       * routes exist for.
       */
      yield* peers.learn(target, ["http://moved-here:9"], "px")
      const after = (yield* peers.list()).find((entry) => entry.networkID === target)?.routes ?? []
      expect(after.length).toBe(CommunityPeers.MAX_ROUTES_PER_PEER)
      expect(after[0], "the address it just moved to was dropped by the cap").toBe("http://moved-here:9")
    }),
  )
})

describe("the introduction edge survives housekeeping (honesty-ledger (y)/(dd))", () => {
  /**
   * 🔴 (y) says a record of what a peer did must not live on the peer row, because this table's
   * housekeeping deletes rows for the system's convenience. §4c item 3 put the introduction edge
   * there anyway — the one signal AGENTS.md calls the difference between a cluster and a consensus.
   *
   * The route-uniqueness door was shut for hearsay in 2026-08-17. This is the other one: `evict()`
   * dropped the edge the moment a peer went quiet, which is (y)'s predicted harm exactly.
   */
  it.effect("🔴 a peer we have DEALT WITH outlives strangers when the table is full", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      const ledger = yield* CommunityObservation.Service
      const doorman = mintIdentity().networkID

      // Somebody we actually dealt with, introduced by our doorman — the row whose loss (y) warns of.
      const engaged = mintIdentity().networkID
      yield* peers.learn(engaged, ["http://203.0.113.9:4096"], "px", doorman)
      yield* ledger.recordFirstHand({
        subject: engaged,
        at: Date.now(),
        context: "asked",
        outcome: CommunityObservation.Outcome.ANSWERED,
      })

      // …then fill the table past its bound with strangers, every one of them seen MORE recently.
      for (let n = 0; n < CommunityPeers.MAX_PEERS + 20; n++) {
        const stranger = mintIdentity().networkID
        yield* peers.learn(stranger, [`http://203.0.113.${(n % 200) + 10}:${4100 + n}`], "px", doorman)
        yield* peers.seen(stranger)
      }

      const rows = yield* peers.list()
      // ⚠️ The bound is still ABSOLUTE — a priority within the cap, never an exemption from it, or
      // this would be the disk-fill attack the cap exists to stop.
      expect(rows.length, "the table stays under its bound").toBeLessThanOrEqual(CommunityPeers.MAX_PEERS)
      const kept = rows.find((row) => row.networkID === engaged)
      expect(kept, "a peer we dealt with is not dropped for going quiet").toBeDefined()
      expect(kept?.introducedBy, "and its introduction edge comes with it").toBe(doorman)
    }),
  )
})
