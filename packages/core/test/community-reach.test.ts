import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunityReach } from "@novaclaw/core/community/reach"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * 🔴 P2P review 2026-08-17, findings 1.3, 1.5, 1.9 and 1.14 — everything that happens between "a
 * stranger told us an address" and "we dialled it".
 *
 * Four defects, one shape: **a claim treated as a fact.** A PX answer's route strings were stored
 * verbatim and dialled (1.3); a PX claim about somebody else's route DELETED the verified row for
 * that address and rewrote its doorman edge (1.5); six diallers unioned the block-filtered contacts
 * table with the unfiltered peers table, so a blocked peer was dialled and `publish` handed them the
 * user's own messages (1.9); and search read the peers table only, never the user's contacts (1.14).
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityContacts.node, CommunityPeers.node]),
  ),
)

const identity = (fill: number) => `nid_${Buffer.alloc(32, fill).toString("base64url")}`

const stores = Effect.gen(function* () {
  return { contacts: yield* CommunityContacts.Service, peers: yield* CommunityPeers.Service }
})

describe("what we may dial, and who may write it", () => {
  it.effect("🔴 1.3 — a poisoned PX route is never STORED, so `sample` cannot pass it on", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      const attacker = identity(1)

      // Every shape the review dialled. `learn` returns false because nothing survived validation.
      for (const poison of [
        "https://evil.example/#",
        "https://evil.example/?x=",
        "https://real.example@evil.example",
        "http://169.254.169.254",
        "http://127.0.0.1:4096",
        "http://2130706433",
      ]) {
        expect(yield* peers.learn(attacker, [poison], "px"), `${poison} must not be learned`).toBe(false)
      }
      expect(yield* peers.list()).toEqual([])

      // The control: an ordinary hearsay route IS learned, canonicalised.
      expect(yield* peers.learn(attacker, ["HTTPS://Peer.Example/"], "px")).toBe(true)
      expect((yield* peers.list())[0]!.routes).toEqual(["https://peer.example"])
    }),
  )

  it.effect("🔴 1.3 — the same address a stranger may not name, WE may, when we found it ourselves", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      // LAN discovery and a typed address are how this product is meant to be entered (AGENTS.md:
      // "Discovery is the LAN, peer exchange, a public Kademlia DHT, or an address a user types"),
      // so a rule that refused private addresses outright would take the LAN half off the air.
      expect(yield* peers.learn(identity(2), ["http://127.0.0.1:4096"], "manual")).toBe(true)
      expect(yield* peers.learn(identity(3), ["http://192.168.1.5:4096"], "lan")).toBe(true)
      expect((yield* peers.list()).length).toBe(2)
    }),
  )

  it.effect("🔴 1.5 — hearsay may ADD a row; it may not evict a dialled one or rewrite its edge", () =>
    Effect.gen(function* () {
      const peers = yield* CommunityPeers.Service
      const honest = identity(4)
      const impostor = identity(5)
      const route = "http://192.168.1.9:4096"

      // Learned by dialling it on the LAN: this row is EVIDENCE, not a claim.
      yield* peers.learn(honest, [route], "lan")
      // A stranger's PX answer claims the same address under a different key. Before the fix this
      // deleted the honest row, and the next `learn` re-inserted it with whatever introducer was in
      // scope — rewriting the one Sybil signal AGENTS.md names.
      yield* peers.learn(impostor, [route], "px", identity(6))

      const listed = yield* peers.list()
      const surviving = listed.find((peer) => peer.networkID === honest)
      expect(surviving, "the dialled row must survive a stranger's claim about its address").toBeDefined()
      expect(surviving!.source).toBe("lan")
      expect(surviving!.introducedBy, "and its provenance must not be rewritten").toBeUndefined()

      // The control that keeps the original rule alive: a route WE dialled under a new key is a
      // rotation, and the stale row goes.
      yield* peers.learn(identity(7), [route], "lan")
      const after = yield* peers.list()
      expect(after.filter((peer) => peer.routes.includes(route)).map((peer) => peer.networkID)).toEqual([identity(7)])
    }),
  )

  it.effect("🔴 1.9 — a BLOCKED peer is not dialled, whichever table their route is in", () =>
    Effect.gen(function* () {
      const { contacts, peers } = yield* stores
      const blocked = identity(8)

      // The block is a fact about a PERSON. Their route lives in the peers table, which has no
      // `blocked` column — which is exactly why every dialler that unioned the two tables kept
      // dialling them. Observed on the wire: POST /blocked/api/community/inbound with the message.
      yield* contacts.add({ networkID: blocked, petname: "someone the user refuses to hear" })
      yield* contacts.setBlocked(blocked, true)
      yield* peers.learn(blocked, ["https://blocked.example"], "px")

      const reachable = yield* CommunityReach.reachable({ contacts, peers })
      expect(reachable.map((entry) => entry.route)).not.toContain("https://blocked.example")
      expect(yield* CommunityReach.routesFor({ contacts, peers, to: blocked })).toEqual([])

      // The control: unblocking puts them back, so this is a block and not a broken list.
      yield* contacts.setBlocked(blocked, false)
      expect((yield* CommunityReach.reachable({ contacts, peers })).map((entry) => entry.route)).toContain(
        "https://blocked.example",
      )
    }),
  )

  it.effect("🔴 1.14 — the user's own CONTACTS are dialled, and first", () =>
    Effect.gen(function* () {
      const { contacts, peers } = yield* stores
      const friend = identity(9)
      const stranger = identity(10)

      // A fresh install whose one entry point is a hand-added contact: search read `peers.list()`
      // only, so it dialled the untrusted table and skipped the trusted one — empty results until
      // peer exchange happened to return that same peer.
      yield* contacts.add({ networkID: friend, routes: ["https://friend.example"] })
      yield* peers.learn(stranger, ["https://stranger.example"], "px")

      const reachable = yield* CommunityReach.reachable({ contacts, peers })
      expect(reachable.map((entry) => entry.route)).toContain("https://friend.example")
      // Contacts FIRST: the cap cuts the tail, and the people the user added must survive a slice
      // that a table filled by strangers would otherwise crowd out.
      expect(reachable[0]!.networkID).toBe(friend)
      expect((yield* CommunityReach.reachable({ contacts, peers, limit: 1 })).map((entry) => entry.route)).toEqual([
        "https://friend.example",
      ])
    }),
  )
})
