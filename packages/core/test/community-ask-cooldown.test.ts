import { describe, expect } from "bun:test"
import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
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
import { CommunityTool } from "@novaclaw/core/tool/community"
import { Database } from "@novaclaw/core/database/database"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"
import { mintIdentity, type MintedIdentity } from "./lib/community"

/**
 * 🔴 **Outbound rule 10 of the new-peer-door checklist: *"add a cooldown if the call can repeat."***
 *
 * An ask repeats trivially — the permission is granted per peer and SAVED, so an "always" answer
 * makes every later ask free from the user's side, and a model loop repeats in milliseconds. What it
 * spends is somebody else's model turn, against a per-asker budget that defaults to five A DAY.
 *
 * ⚠️ Keyed on peer AND question. A follow-up is legitimate and often immediate — an agent reads an
 * answer and asks the obvious next thing — so a per-peer window would punish exactly the conversation
 * this feature exists to have. An identical repeat is always pathological.
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

const stranger = () => mintIdentity().networkID

/**
 * A stub that answers the identity probe the way a REAL peer must since Codex P1: with a signature
 * over the caller's challenge.
 *
 * ⚠️ Before that change a bare `{networkID}` was enough, and this stub said so — which is precisely
 * the claim the challenge exists to stop anyone making. The stub therefore holds a keypair now: a
 * fixture that could not prove possession would be asserting that an unproven peer still counts.
 */
const provingIdentity = (identity: MintedIdentity, url: URL): Response | undefined => {
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

/** Nothing answers here, so every ask reaches the dial and fails there — which is what we want to count. */
const DEAD = "http://127.0.0.1:4"

describe("asking the same thing twice", () => {
  it.effect("⚠️ a peer we cannot reach is told THAT, not the cooldown", () =>
    Effect.gen(function* () {
      /**
       * The order matters: the cooldown is checked after route resolution, so an instance that knows
       * nobody keeps getting the honest answer instead of being told to wait for a call that never
       * went anywhere.
       */
      CommunityConsent.applied({ consented: true }, { enabled: true })
      const sync = yield* CommunitySync.Service
      const nobody = stranger()

      for (let attempt = 0; attempt < 3; attempt++) {
        const result = yield* sync.askPeer(nobody, "what happened today?")
        expect(result.reason, "no route must never become a cooldown").toBe("no-route")
      }
    }),
  )

  it.effect("🔴 the cooldown does not start on an ask that reached NOBODY", () =>
    Effect.gen(function* () {
      /**
       * 🔴 The trap the catch-up cooldown records in its own comment: stamping the ATTEMPT means an
       * instance whose first ask happens a second before discovery finds anyone then refuses to try
       * again for a minute. A fresh install does exactly that.
       *
       * The peer here has a route, so the ask gets as far as the dial and fails — and because nobody
       * answered, the next identical ask must still be attempted rather than refused as a repeat.
       */
      CommunityConsent.applied({ consented: true }, { enabled: true })
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      const peer = stranger()
      yield* peers.learn(peer, [DEAD], "lan")

      const first = yield* sync.askPeer(peer, "what happened today?")
      const second = yield* sync.askPeer(peer, "what happened today?")

      expect(first.reason).toBe("unreachable")
      expect(second.reason, "an unreachable peer must not look like a repeat").toBe("unreachable")
    }),
  )
})

describe("and the guard actually BITES", () => {
  it.effect("🔴 an identical question to a peer that ANSWERED THE PROBE is refused as too-soon", () =>
    Effect.gen(function* () {
      /**
       * 🔴 Without this, every other test in this file passes against a cooldown that never fires.
       * Three of them assert it does NOT trigger — which is worth asserting, and is exactly the shape
       * of a guard nobody notices is dead.
       *
       * A stub that answers only the identity probe is enough: the stamp is written the moment we
       * confirm somebody real is there, which is the point after which a repeat costs THEM.
       */
      CommunityConsent.applied({ consented: true }, { enabled: true })
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      const identity = mintIdentity()
      const peer = identity.networkID

      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const proving = provingIdentity(identity, new URL(request.url))
          if (proving !== undefined) return proving
          // The ask itself fails, deliberately: what is under test is the STAMP, not the answer.
          return new Response("no", { status: 500 })
        },
      })

      try {
        yield* peers.learn(peer, [`http://127.0.0.1:${server.port}`], "lan")

        const first = yield* sync.askPeer(peer, "what happened today?")
        expect(first.reason, "the stub refuses the ask itself, which is fine").not.toBe("too-soon")

        const repeat = yield* sync.askPeer(peer, "what happened today?")
        expect(repeat.reason, "the same question inside the window must not be sent again").toBe("too-soon")

        /**
         * ⚠️ And a DIFFERENT question is still allowed. A per-peer window would punish exactly the
         * conversation this feature exists to have: an agent reads an answer and asks the obvious
         * next thing, immediately.
         */
        const followUp = yield* sync.askPeer(peer, "and what about tomorrow?")
        expect(followUp.reason, "a follow-up is not a repeat").not.toBe("too-soon")
      } finally {
        server.stop(true)
      }
    }),
  )
})

describe("how long ONE ask can take", () => {
  it.effect("🔴 six stale routes cost what one costs", () =>
    Effect.gen(function* () {
      /**
       * 🔴 A per-request budget inside a loop is not a budget. A peer may hold up to
       * `MAX_CONTACT_ROUTES` addresses, so raising the per-answer wait to 60 s took the worst case
       * from 120 s to 420 s — seven minutes of an agent, and of whoever is waiting on it, for one
       * question. That regression arrived WITH the fix that raised the wait, which is how a bound
       * granted in one place becomes a hang in another.
       *
       * ⚠️ Timed against a peer whose every address is dead, which is the shape that used to
       * multiply. The assertion is deliberately loose — what is under test is that the total is
       * bounded by ONE deadline rather than by the number of routes, not the exact figure.
       */
      CommunityConsent.applied({ consented: true }, { enabled: true })
      const peers = yield* CommunityPeers.Service
      const sync = yield* CommunitySync.Service
      const peer = stranger()

      const many = Array.from({ length: 6 }, (_, index) => `http://127.0.0.1:${4 + index}`)
      yield* peers.learn(peer, many, "lan")

      const started = Date.now()
      const result = yield* sync.askPeer(peer, "what happened today?")
      const took = Date.now() - started

      expect(result.reason).toBe("unreachable")
      // Six dead routes, each refused instantly by the OS: the point is that nothing multiplied.
      expect(took, "six routes must not cost six budgets").toBeLessThan(CommunitySync.ASK_TOTAL_MS)
    }),
  )

  it.effect("⚠️ and the budgets stay in the order that makes them mean anything", () =>
    Effect.gen(function* () {
      /**
       * Three numbers, and only their RELATIONSHIP is a guarantee: an answer may take longer than a
       * database read; one whole ask may take a little more than one answer; and neither may exceed
       * the seam's own backstop.
       */
      expect(CommunitySync.ANSWER_TIMEOUT_MS).toBeGreaterThan(10_000)
      expect(CommunitySync.ASK_TOTAL_MS).toBeGreaterThanOrEqual(CommunitySync.ANSWER_TIMEOUT_MS)
      expect(CommunitySync.ASK_TOTAL_MS).toBeLessThan(6 * CommunitySync.ANSWER_TIMEOUT_MS)
    }),
  )
})

describe("what the agent is told", () => {
  it.effect("🔴 a cooldown refusal names it as OURS, not as the peer being silent", () =>
    Effect.gen(function* () {
      /**
       * A model told only "could not ask" reports the peer as unresponsive — measured on a real run
       * with a different message, where a bare failure became an invented story about a daemon. What
       * actually happened is that we declined to spend their budget twice on one sentence.
       */
      const message = CommunityTool.askFailure("nid_abc", "too-soon")
      expect(message).toContain("nid_abc")
      expect(message, "it must say the question was not sent").toContain("not sent again")
      expect(message, "and why that is a courtesy rather than a fault").toContain("costs them")
      // ⚠️ Distinct from every other reason, or a model cannot tell which half to act on.
      const others = ["no-route", "unreachable", "bad-signature", "wrong-author", "no-answer"].map((reason) =>
        CommunityTool.askFailure("nid_abc", reason),
      )
      expect(others).not.toContain(message)
    }),
  )
})
