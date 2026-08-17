import { sign as nodeSign } from "node:crypto"
import { describe, expect, test } from "bun:test"
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
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"
import { mintIdentity, type MintedIdentity } from "./lib/community"

/**
 * 🔴 Codex review 2026-08-17, P1 — **the route-to-identity binding was only a string claim.**
 *
 * The identity probe answered a `networkID`, a sealing key and a static sealing-key signature, and
 * nothing in it was bound to the request. So an endpoint could name any identity it liked: replay a
 * victim's published tuple and this instance treats the route as theirs. That is enough to become
 * the victim's preferred route (a successful exchange prepends it to the user's contact routes), to
 * accept a DM it cannot open and return the uniform acknowledgement so `sendDirect` reports success,
 * and — because a refusal is unsigned but recorded as a first-hand dealing — to write false
 * observations about somebody who was never involved.
 *
 * ⚠️ These drive the REAL `sync` against a real socket. A unit test of `verifyIdentityProof` would
 * pass whether or not any caller used it, which is the shape of every ledger finding 1.19 collected.
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

/** Answers the probe with a real signature over the caller's challenge — an honest peer. */
const honestIdentity = (identity: MintedIdentity, url: URL): Response | undefined => {
  if (url.pathname !== "/api/community/identity") return undefined
  const challenge = url.searchParams.get("challenge")
  const bytes = challenge === null ? undefined : InstanceIdentityStore.identityProofBytes(challenge)
  return Response.json({
    networkID: identity.networkID,
    ...(bytes === undefined
      ? {}
      : { proof: nodeSign(null, Buffer.from(bytes), identity.privateKey).toString("base64url") }),
  })
}

describe("who answers an address must PROVE it (Codex P1)", () => {
  test("the proof is bound to THIS challenge and to THAT key", () => {
    const peer = mintIdentity()
    const other = mintIdentity()
    const challenge = Buffer.alloc(32, 7).toString("base64url")
    const proof = nodeSign(
      null,
      Buffer.from(InstanceIdentityStore.identityProofBytes(challenge)!),
      peer.privateKey,
    ).toString("base64url")

    expect(InstanceIdentityStore.verifyIdentityProof(peer.networkID, challenge, proof)).toBe(true)
    // Another key's name on the same proof — the replay a hostile endpoint would attempt.
    expect(InstanceIdentityStore.verifyIdentityProof(other.networkID, challenge, proof)).toBe(false)
    // The same proof against a different challenge: this is what makes it possession rather than a
    // quotation of something they were handed once.
    expect(
      InstanceIdentityStore.verifyIdentityProof(peer.networkID, Buffer.alloc(32, 8).toString("base64url"), proof),
    ).toBe(false)
    // Malformed everything, refused rather than thrown — the door is anonymous.
    for (const bad of [undefined, "", "!!!!", Buffer.alloc(64).toString("base64url")])
      expect(InstanceIdentityStore.verifyIdentityProof(peer.networkID, challenge, bad)).toBe(false)
    // A challenge that is not 32 bytes is not a challenge: nothing may be signed over it, so the
    // endpoint can never be used as a signing oracle for bytes of somebody else's choosing.
    expect(InstanceIdentityStore.identityProofBytes(Buffer.alloc(8).toString("base64url"))).toBeUndefined()
  })

  it.effect("🔴 an endpoint claiming somebody else's identity is not believed", () =>
    Effect.gen(function* () {
      CommunityConsent.applied({ consented: true }, { enabled: false })
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      const victim = mintIdentity()

      // The hostile endpoint answers exactly what the old probe accepted: the victim's name, and no
      // proof it holds their key. It cannot produce one, which is the whole point.
      const impostor = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/api/community/identity") return Response.json({ networkID: victim.networkID })
          return Response.json({ received: true })
        },
      })

      try {
        const route = `http://127.0.0.1:${impostor.port}`
        // `identify` is what the doorman screen shows the user, so believing this endpoint would put
        // the victim's key on the address a stranger controls.
        expect(yield* sync.identify(route)).toBeUndefined()
        // …and `learnFrom` would have written the same claim into the peer table.
        expect(yield* sync.learnFrom([route], "lan")).toBe(0)
        expect(yield* peers.list()).toEqual([])

        // A DM to the victim must not be handed to whoever answered: the impostor returns the
        // uniform ack, so before the proof this reported `sent: true`.
        yield* peers.learn(victim.networkID, [route], "lan")
        const sent = yield* sync.sendDirect(victim.networkID, "private")
        expect(sent.sent).toBe(false)
        // And nothing may be recorded as a dealing with the victim on the strength of that exchange.
        expect(yield* (yield* CommunityObservation.Service).about(victim.networkID)).toEqual([])
      } finally {
        impostor.stop(true)
      }
    }),
  )

  it.effect("🔴 the control: an endpoint that CAN prove it is believed, and nothing else changed", () =>
    Effect.gen(function* () {
      // A guard that refused every probe would pass the test above and take the network off the air:
      // discovery, direct messages and asking all begin with this one request.
      CommunityConsent.applied({ consented: true }, { enabled: false })
      const sync = yield* CommunitySync.Service
      const peers = yield* CommunityPeers.Service
      const peer = mintIdentity()

      const honest = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          return honestIdentity(peer, url) ?? Response.json({ received: true })
        },
      })

      try {
        const route = `http://127.0.0.1:${honest.port}`
        expect((yield* sync.identify(route))?.networkID).toBe(peer.networkID)
        expect(yield* sync.learnFrom([route], "lan")).toBe(1)
        expect((yield* peers.list()).map((entry) => entry.networkID)).toEqual([peer.networkID])
      } finally {
        honest.stop(true)
      }
    }),
  )
})
