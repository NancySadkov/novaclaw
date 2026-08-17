import { describe, expect } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { Database } from "@novaclaw/core/database/database"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

/**
 * 🔴 **§5(i) of `notes/spec/honesty-ledger.md`: the user outranks the ledger.**
 *
 * *"A blocked peer with perfect standing stays blocked."* `AGENTS.md` puts it the other way round:
 * what changes the user's standing — who they trust, who they block — stays out of the agent's reach.
 *
 * ⚠️ Blocking is stored on the CONTACT row, and `contacts.bootstrap()` has always honoured it. But a
 * peer met on the LAN, through peer exchange or through the DHT lives in the PEERS table, and both
 * dialling paths read BOTH tables. Measured 2026-08-17: the block reached the half it was written on
 * and no further, so an agent could put a question to somebody its user had blocked.
 *
 * 🔴 This drives the REAL functions. An earlier version of this file re-implemented the union it was
 * asserting about and therefore could not see the fix at all — a test that copies the code under test
 * is testing the copy.
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
      CommunitySync.node,
    ]),
  ),
)

const stranger = () => {
  const { publicKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  return `nid_${raw.toString("base64url")}`
}

/**
 * An address nothing answers on. That is the point: a peer we are allowed to dial reports
 * `unreachable` (we tried and nobody was there), while a blocked one must report `no-route` (we
 * never tried). Those two answers are how this file tells "honoured" from "attempted".
 */
const DEAD = "http://127.0.0.1:4"

describe("a blocked peer is not dialled", () => {
  it.effect("🔴 asking a BLOCKED peer never reaches the wire", () =>
    Effect.gen(function* () {
      CommunityConsent.applied({ consented: true }, { enabled: true })
      const contacts = yield* CommunityContacts.Service
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      const blocked = stranger()

      // Met on the LAN, which is how anybody is ordinarily met — so the address lives in PEERS,
      // the table the block was never written to.
      yield* peers.learn(blocked, [DEAD], "lan")
      yield* contacts.add({ networkID: blocked, routes: [DEAD] })
      yield* contacts.setBlocked(blocked, true)

      const asked = yield* sync.askPeer(blocked, "what happened today?")
      expect(asked.reason, "a blocked peer must yield NO route, not a failed dial").toBe("no-route")

      // The same rule, on the other path that reads the same tables.
      const sent = yield* sync.sendDirect(blocked, "hello")
      expect(sent.sent).toBe(false)
      expect(sent.reason, "a direct message to a blocked peer must not be attempted either").toBe("no-route")
    }),
  )

  it.effect("⚠️ and the control: an UNBLOCKED peer is dialled, so the assertion above can fail", () =>
    Effect.gen(function* () {
      /**
       * Without this the test above would pass against a store that returns nothing, a consent gate
       * that refuses everything, or a layer that never built — and `no-route` would mean "this test
       * proves nothing" rather than "the block was honoured".
       */
      CommunityConsent.applied({ consented: true }, { enabled: true })
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      const ordinary = stranger()

      yield* peers.learn(ordinary, [DEAD], "lan")
      const asked = yield* sync.askPeer(ordinary, "what happened today?")
      expect(asked.reason, "an unblocked peer must be TRIED — unreachable, not route-less").toBe("unreachable")
    }),
  )
})
