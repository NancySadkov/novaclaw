import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"
import { mintIdentity } from "./lib/community"

/**
 * 🔴 P2P review finding 1.14 — **search dialled the untrusted table and skipped the trusted one.**
 *
 * `search.routes` read `peers.list()` only, and `contactAdd` writes the CONTACTS table. So a fresh
 * install whose one entry point is a hand-added doorman searched nobody at all until peer exchange
 * happened to return that same peer — the one person the user explicitly trusted was the one the
 * feature would not ask.
 *
 * ⚠️ This exists because the fix was covered only by a SOURCE ledger (`community-dial-list-ledger`),
 * which proves the diallers call the shared builder and cannot prove that a contact-only instance
 * reaches anybody. Found by auditing which findings had a test citing them rather than by trusting
 * the closure notes — two of nineteen did not, and this was the behavioural one.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityContacts.node,
      CommunityPeers.node,
      CommunitySearch.node,
    ]),
  ),
)

/**
 * ⚠️ The consent gate is PROCESS-WIDE, so a file that opens it must close it. Leaving it open let
 * every later test in this shard behave like a JOINED instance — and one of them dialled, which is
 * how this file wall-clock-killed the core unit at 600s the first time it ran in the full gate. It
 * passed alone in half a second; only the composition showed it.
 */
afterEach(() => {
  CommunityConsent.resetGate()
})

describe("search asks the people the user actually trusts (finding 1.14)", () => {
  it.effect("🔴 an instance whose ONLY entry point is a contact still dials", () =>
    Effect.gen(function* () {
      CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })
      const contacts = yield* CommunityContacts.Service
      const peers = yield* CommunityPeers.Service
      const search = yield* CommunitySearch.Service

      // The fresh-install shape: a doorman the user typed in, and an empty peer table.
      const doorman = mintIdentity().networkID
      let asked = 0
      const server = Bun.serve({
        port: 0,
        fetch() {
          asked++
          return Response.json({ channels: [] })
        },
      })
      try {
        yield* contacts.add({
          networkID: doorman,
          petname: "the one who let us in",
          routes: [`http://127.0.0.1:${server.port}`],
          trust: 5,
        })
        expect((yield* peers.list()).length, "the peer table must be empty, or this proves nothing").toBe(0)

        yield* search.search("gguf 7b")
        expect(asked, "the one peer the user trusts is the one search must ask").toBeGreaterThan(0)
      } finally {
        server.stop(true)
      }
    }),
  )
})
