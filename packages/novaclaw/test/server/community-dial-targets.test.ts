import { describe, expect, test } from "bun:test"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"

/**
 * 🔴 Every path this instance dials on a REMOTE peer must be one that peers may reach WITHOUT
 * credentials — and until this existed, nothing checked it.
 *
 * Bootstrap by address probed `/global/health`, which is authenticated. Against an unsecured
 * instance that works, so every two-instance journey passed; against an instance with a password —
 * the recommended setup for anything reachable from outside — discovery failed completely:
 * `{"learned":0,"asked":0,"peers":0}`, an empty peer table, `no-peers`, while every peer path on the
 * far side answered 200.
 *
 * ⚠️ **The failure direction is what made it invisible.** A path wrongly PUBLIC leaks and gets
 * noticed; a path wrongly AUTHENTICATED just makes the network quietly stop working for the people
 * who secured their instance, and every screen still looks right to its owner.
 *
 * Both sides are derived — the dial targets from the modules that do the dialling, the public set
 * from the group that declares it — so neither a new endpoint nor a new caller can drift past this.
 */
describe("what this instance dials on a peer", () => {
  /** Every outbound target, collected from the modules that own the dialling. */
  const DIALLED: ReadonlyArray<readonly [string, string]> = [
    ["sync.summary", CommunitySync.SYNC_SUMMARY_PATH],
    ["sync.ids", CommunitySync.SYNC_IDS_PATH],
    ["sync.messages", CommunitySync.SYNC_MESSAGES_PATH],
    ["sync.peers", CommunitySync.PEERS_PATH],
    ["sync.listed", CommunitySync.LISTED_PATH],
    ["sync.succession", CommunitySync.SUCCESSION_PATH],
    ["sync.dm", CommunitySync.DM_PATH],
    ["sync.offer", CommunitySync.OFFER_PATH],
    ["sync.identity", CommunitySync.IDENTITY_PATH],
    /**
     * 🔴 Added 2026-08-17 with the ASKING half. `communityAsk` had shipped with no caller inside
     * NovaClaw at all, so this instance never dialled it — the endpoint answered questions nothing
     * here could send.
     */
    ["sync.ask", CommunitySync.ASK_PATH],
    ["search", CommunitySearch.SEARCH_PATH],
    ["transport.inbound", CommunityTransport.INBOUND_PATH],
  ]

  test("🔴 every dialled path is one a stranger may reach without credentials", () => {
    const publicPaths = new Set<string>(Object.values(CommunityPeerPaths))
    for (const [name, path] of DIALLED)
      expect(
        publicPaths.has(path),
        `${name} dials ${path}, which is NOT in CommunityPeerPaths — a peer with a password would refuse it`,
      ).toBe(true)
  })

  test("🔴 the collection above is COMPLETE — a new dial target cannot be omitted from it", () => {
    /**
     * ⚠️ The list is hand-written and therefore the weak half: a new caller could dial a fresh path
     * and simply not be added here. So it is checked against the modules' own exports — every
     * `*_PATH` constant they publish must appear above, which is the thing a new dial target
     * cannot avoid creating.
     */
    const exported = [
      ...Object.entries(CommunitySync).filter(([k]) => k.endsWith("_PATH")),
      ...Object.entries(CommunitySearch).filter(([k]) => k.endsWith("_PATH")),
      ...Object.entries(CommunityTransport).filter(([k]) => k.endsWith("_PATH")),
    ].map(([, v]) => v as string)

    const covered = new Set(DIALLED.map(([, p]) => p))
    for (const path of exported)
      expect(covered.has(path), `a module exports ${path} as a dial target but this test does not check it`).toBe(true)
    expect(exported.length).toBeGreaterThan(0)
  })
})
