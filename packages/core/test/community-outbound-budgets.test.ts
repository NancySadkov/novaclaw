import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { CommunityWork } from "@novaclaw/core/community/work"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"
import { mintIdentity } from "./lib/community"

/**
 * 🔴 P2P review 2026-08-17, §2 (unit 3 F6) — **catch-up could be starved DETERMINISTICALLY.**
 *
 * Three facts composed into a permanent outage rather than a slow one:
 *
 *   · `reachable` is stably ordered, contacts before strangers, so the same peer is dialled first
 *     every time;
 *   · `sync` stamped its cooldown once it had "somebody to ask" — which is not somebody who
 *     ANSWERED — so a dead first contact burned the thirty-second window;
 *   · the tool that drives catch-up gives up after 5 s, and a dead peer costs seconds.
 *
 * So the second peer was never reached, the window was always spent, and retrying changed nothing:
 * the same peer, the same failure, forever.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityChannels.node,
      CommunityContacts.node,
      CommunityPeers.node,
      CommunityDirect.node,
      CommunityOffer.node,
      CommunitySuccession.node,
      CommunityObservation.node,
      CommunityTransport.node,
      CommunitySync.node,
    ]),
  ),
)

/** A port nothing listens on: every dial to it fails fast, which is the honest shape of a dead peer. */
const DEAD = "http://127.0.0.1:9"

describe("what one catch-up may spend (review §2)", () => {
  it.effect("🔴 a sync that reached NOBODY leaves the window open for the peer who arrives next", () =>
    Effect.gen(function* () {
      /**
       * ⚠️ The property has to be stated in terms of a peer we learn AFTERWARDS, and the first
       * version of this test did not — it asserted that two failing syncs both return zeroes, which
       * they do whether or not the window was spent. A test that cannot tell the fix from the defect
       * is the exact shape this review keeps finding in other people's ledgers.
       *
       * Discovery is continuous: mDNS, peer exchange and the DHT all add rows while the panel is
       * open. So the case that matters is the one a fresh install lives through — the first sync
       * finds nobody, a peer appears a second later, and the catch-up either dials it now or refuses
       * to for the next thirty seconds.
       */
      CommunityConsent.applied({ consented: true }, { enabled: false })
      const channels = yield* CommunityChannels.Service
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      yield* channels.join("#NovaClaw")
      yield* peers.learn(mintIdentity().networkID, [DEAD], "lan")

      expect(yield* sync.sync("#NovaClaw")).toEqual({ peers: 0, fetched: 0 })

      let asked = 0
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === "/api/community/sync/summary") {
            asked++
            return Response.json({ buckets: [] })
          }
          return new Response("no", { status: 404 })
        },
      })
      try {
        yield* peers.learn(mintIdentity().networkID, [`http://127.0.0.1:${server.port}`], "lan")
        yield* sync.sync("#NovaClaw")
        expect(asked, "a sync that reached nobody must not block the one that would").toBe(1)
      } finally {
        server.stop(true)
      }
    }),
  )

  it.effect("🔴 a route that just failed is skipped, so the next attempt starts further along", () =>
    Effect.gen(function* () {
      /**
       * `reachable` is stably ordered with contacts first, so the dead one was dialled first every
       * time. Counted rather than timed: a dial that is refused by the kernel costs about nothing, so
       * a stopwatch would pass on a fast failure and prove only that loopback is quick.
       */
      CommunityConsent.applied({ consented: true }, { enabled: false })
      const channels = yield* CommunityChannels.Service
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      yield* channels.join("#NovaClaw")

      let asked = 0
      // Answers the door and refuses the summary: a peer that is REACHABLE and useless, which is
      // what an incompatible or half-broken instance looks like from here.
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === "/api/community/sync/summary") {
            asked++
            return new Response("no", { status: 500 })
          }
          return new Response("no", { status: 404 })
        },
      })
      try {
        yield* peers.learn(mintIdentity().networkID, [`http://127.0.0.1:${server.port}`], "lan")
        yield* sync.sync("#NovaClaw")
        expect(asked).toBe(1)
        // Nobody answered, so the ROOM's window stayed open — and the route's own memory is what
        // stops that turning into dialling the same failure on every keystroke.
        yield* sync.sync("#NovaClaw")
        expect(asked, "a remembered failure is skipped, not re-dialled").toBe(1)
      } finally {
        server.stop(true)
      }
    }),
  )

  it.effect("⚠️ and the control: a room that WAS caught up still holds its cooldown", () =>
    Effect.gen(function* () {
      /**
       * The cooldown exists because both callers can repeat far faster than the network changes. A
       * fix that simply stopped stamping it would trade a starvation bug for a flood — spending a
       * peer's bandwidth on every keystroke of the panel.
       */
      CommunityConsent.applied({ consented: true }, { enabled: false })
      const channels = yield* CommunityChannels.Service
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      yield* channels.join("#NovaClaw")

      let asked = 0
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === "/api/community/sync/summary") {
            asked++
            return Response.json({ buckets: [] })
          }
          return new Response("no", { status: 404 })
        },
      })
      try {
        yield* peers.learn(mintIdentity().networkID, [`http://127.0.0.1:${server.port}`], "lan")
        yield* sync.sync("#NovaClaw")
        expect(asked).toBe(1)
        // Immediately again: refused by the cooldown, because this one really did reach somebody.
        yield* sync.sync("#NovaClaw")
        expect(asked, "a successful catch-up holds its window").toBe(1)
      } finally {
        server.stop(true)
      }
    }),
  )

  it.effect("🔴 one `say` does not open a socket to every route the peer table holds", () =>
    Effect.gen(function* () {
      /**
       * The peer table is filled by strangers describing strangers — 500 rows, eight routes each —
       * so an attacker who fills it to its own legitimate bound turns every message the user sends
       * into 4,000 POSTs from their laptop. Nothing capped the fan-out and nothing bounded the
       * total, and the message was already in the user's own log before any of it started.
       *
       * ⚠️ Real listeners, one per route, because the cap has to be observed as SOCKETS NOT OPENED.
       * Counting rows out of `reachable` would test the helper and leave the caller free to ask for
       * all of them — which is what it did.
       */
      CommunityConsent.applied({ consented: true }, { enabled: false })
      const channels = yield* CommunityChannels.Service
      const peers = yield* CommunityPeers.Service
      const transport = yield* CommunityTransport.Service
      yield* channels.join("#NovaClaw")

      let hit = 0
      const servers = Array.from({ length: CommunityTransport.MAX_PUBLISH_TARGETS + 16 }, () =>
        Bun.serve({
          port: 0,
          fetch() {
            hit++
            return Response.json({ received: true })
          },
        }),
      )
      try {
        for (const server of servers)
          yield* peers.learn(mintIdentity().networkID, [`http://127.0.0.1:${server.port}`], "lan")

        const message = yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "hello everyone" })
        yield* transport.publish(CommunityWork.prove(message)!)
        expect(hit, "the fan-out is bounded by what we chose, not by what strangers stored").toBeLessThanOrEqual(
          CommunityTransport.MAX_PUBLISH_TARGETS,
        )
        // …and it is not zero: a cap that published to nobody would pass the line above and break the
        // feature.
        expect(hit).toBeGreaterThan(0)
      } finally {
        for (const server of servers) server.stop(true)
      }
    }),
  )

  it.effect("🔴 the numbers themselves are bounds a user can feel", () =>
    Effect.gen(function* () {
      /**
       * `sync` walked up to `MAX_PEERS_ASKED` peers, each costing a summary, up to eight id requests
       * and up to twenty message batches at a 10 s timeout apiece, with nothing bounding the total;
       * `publish` walked every route of every peer — up to 4,000 POSTs for one `say`.
       */
      expect(CommunitySync.SYNC_TOTAL_MS).toBeLessThanOrEqual(30_000)
      expect(CommunityTransport.PUBLISH_TOTAL_MS).toBeLessThanOrEqual(30_000)
      // The fan-out must stay well under what the peer table can hold, or the bound is decorative.
      expect(CommunityTransport.MAX_PUBLISH_TARGETS).toBeLessThan(CommunityPeers.MAX_PEERS)
      // A small read must not be allowed a page of messages' worth of bytes.
      expect(CommunitySync.MAX_SMALL_RESPONSE_BYTES).toBeLessThan(CommunityTransport.MAX_PEER_RESPONSE_BYTES)
    }),
  )
})
