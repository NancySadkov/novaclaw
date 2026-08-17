import { describe, expect } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityObservation } from "@novaclaw/core/community/observation"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { Database } from "@novaclaw/core/database/database"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

/**
 * 🔴 **§5(k) of `notes/spec/honesty-ledger.md`: a dossier, not a log.**
 *
 * *"✗ Fails if `forget` leaves a score behind."* There is no score column by design, but the
 * observations ARE the dossier — what a peer promised, what they delivered, and the agent's own
 * prose about them. A `forget` that removes the address book entry and keeps the notes has not
 * forgotten anybody; it has only stopped being able to write to them.
 *
 * ⚠️ The spec leaves two things open on purpose — whether a forgotten peer's history returns if they
 * are re-added, and whether anything is kept in aggregate — but it is explicit that **the default
 * must be that forget means forget, because the opposite is unrecoverable once shipped.**
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityContacts.node, CommunityPeers.node, CommunityObservation.node]),
  ),
)

const stranger = () => {
  const { publicKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  return `nid_${raw.toString("base64url")}`
}

describe("forget means forget", () => {
  it.effect("🔴 the DEALINGS go with the contact, not just the address", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const peers = yield* CommunityPeers.Service
      const ledger = yield* CommunityObservation.Service
      const peer = stranger()

      yield* peers.learn(peer, ["http://127.0.0.1:4"], "lan")
      yield* contacts.add({ networkID: peer, petname: "someone", routes: ["http://127.0.0.1:4"] })
      yield* ledger.recordFirstHand({ subject: peer, at: 1_000, context: "asked", outcome: "answered" })
      yield* ledger.recordFirstHand({ subject: peer, at: 2_000, context: "asked", outcome: "refused" })

      expect((yield* ledger.about(peer)).length, "the fixture must have written something to forget").toBe(2)

      const forgotten = yield* contacts.forget(peer)
      expect(forgotten).toBe(true)

      /**
       * 🔴 The assertion. A user who clicks Forget is not asking for the address to be dropped while
       * the instance keeps its file on the person — that is the opposite of what the word means, and
       * `AGENTS.md` puts the user above the ledger in every other respect.
       */
      expect(yield* ledger.about(peer), "forgetting a peer must take the dossier with it").toEqual([])
    }),
  )

  it.effect("⚠️ and the control: an untouched peer's dealings SURVIVE", () =>
    Effect.gen(function* () {
      /**
       * Without this, a `forget` that wiped the whole table — or an `about()` that always answered
       * empty — would pass the test above while destroying everybody's history.
       */
      const contacts = yield* CommunityContacts.Service
      const ledger = yield* CommunityObservation.Service
      const kept = stranger()
      const dropped = stranger()

      for (const peer of [kept, dropped]) {
        yield* contacts.add({ networkID: peer, routes: ["http://127.0.0.1:4"] })
        yield* ledger.recordFirstHand({ subject: peer, at: 1_000, context: "asked", outcome: "answered" })
      }

      yield* contacts.forget(dropped)
      expect((yield* ledger.about(kept)).length, "forgetting one peer must not touch another's").toBe(1)
    }),
  )
})
