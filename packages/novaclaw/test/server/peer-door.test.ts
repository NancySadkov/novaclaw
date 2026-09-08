import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { Offline } from "@novaclaw/core/offline"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { MAX_PEER_REQUEST_BYTES } from "../../src/server/routes/instance/httpapi/middleware/peer-door"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/**
 * 🔴 P2P review 2026-08-17, finding 1.1 — **the guard read the URL; the router did not.**
 *
 * The consent gate, the airgap and the 256 KB cap all compared `request.url` to `CommunityPeerPaths`
 * by string equality. Effect's router matches through `find-my-way-ts`, whose defaults ignore a
 * trailing slash, collapse `//`, are case-insensitive and percent-decode. So on a never-consented
 * instance (measured live, port 4103): `/api/community/identity` → 503, and `/api/community/identity/`,
 * `/API/community/identity`, `//api/community/identity` → **200 with the identity**. A 300 KB POST to
 * `/api/community/ask/` was buffered and parsed instead of refused.
 *
 * ⚠️ These tests exist at ROUTE level for the reason the defect exists: the old ones asserted on the
 * pure decision function, which was correct about every string it was shown and was never shown one
 * of these. A ledger that classifies the input the code already handles cannot fail. So this drives
 * the real web handler and asserts on the STATUS a stranger receives.
 *
 * ⚠️ Aliases are DERIVED from each path rather than listed, so a peer endpoint added later is
 * covered by every spelling automatically.
 */

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler
  return {
    request(input: string, init?: RequestInit) {
      return handler(new Request(new URL(input, "http://localhost"), init), HttpApiApp.context)
    },
  }
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

/**
 * Every spelling the router still matches to the same endpoint.
 *
 * ⚠️ `new URL()` normalises `//` and `.` away, so the request has to be built from the raw string —
 * which is exactly how a peer sends it and exactly what the old guard never saw.
 */
const aliasesOf = (path: string): ReadonlyArray<string> => [
  `${path}/`,
  path.replace("/api/", "/API/"),
  path.toUpperCase(),
  `/${path}`,
  // The last character, percent-encoded: `identit%79`. Decoding happens inside the router.
  `${path.slice(0, -1)}%${path.charCodeAt(path.length - 1).toString(16)}`,
]

/** The method each door answers on — a GET on a POST-only route does not match and proves nothing. */
const METHOD: Record<keyof typeof CommunityPeerPaths, "GET" | "POST"> = {
  inbound: "POST",
  syncSummary: "POST",
  syncIds: "POST",
  syncMessages: "POST",
  search: "POST",
  dm: "POST",
  ask: "POST",
  peers: "GET",
  listedChannels: "GET",
  succession: "GET",
  offer: "GET",
  identity: "GET",
}

/**
 * ⚠️ `content-length` is set explicitly. A POST with no declared length is refused by design (the
 * cap can only be applied before the body is read), and `new Request(…, { body })` does not always
 * set the header — so omitting it here would make every POST a 413 and every assertion below a
 * coincidence.
 */
const send = (server: ReturnType<typeof app>, method: "GET" | "POST", path: string, directory: string) =>
  server.request(path, {
    method,
    headers:
      method === "POST"
        ? { "x-novaclaw-directory": directory, "content-type": "application/json", "content-length": "2" }
        : { "x-novaclaw-directory": directory },
    ...(method === "POST" ? { body: "{}" } : {}),
  })

afterEach(async () => {
  // Both gates are process-wide, so a test that borrows one must hand it back — otherwise the next
  // file's "never consented" case silently tests a consented instance, and an airgap outlives its
  // test. (The reverse of the leak `process-wide gate leaks between tests` records.)
  CommunityConsent.resetGate()
  Offline.resetPolicy()
  delete process.env["NOVACLAW_OFFLINE"]
  await disposeAllInstances()
  await resetDatabase()
})

describe("the peer door is on the matched ROUTE, not the URL string (p2p 1.1)", () => {
  test("🔴 every alias of every peer path is refused while this instance has not joined", async () => {
    expect(Object.keys(METHOD).sort()).toEqual(Object.keys(CommunityPeerPaths).sort())
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    /**
     * ⚠️ Stated, not inherited. The un-joined state is also the default, so this line looks
     * redundant — and it is the difference between a test and a coincidence: the gate is
     * process-wide, so a file that ran earlier in the same `bun test` and left it open turns every
     * assertion below into "a joined instance answered its peers", which is the correct behaviour
     * for the state it was actually in. Measured: this test passed alone and failed in the full
     * directory run for exactly that reason.
     */
    CommunityConsent.applied({ consented: false, enabled: false }, { enabled: false })

    for (const [key, path] of Object.entries(CommunityPeerPaths)) {
      const method = METHOD[key as keyof typeof CommunityPeerPaths]
      for (const spelling of [path, ...aliasesOf(path)]) {
        const response = await send(server, method, spelling, tmp.path)
        await cancelBody(response)
        // 503 (refused by this door) or 404 (the router did not match it at all) are both closed.
        // Anything else means a stranger reached a handler on an instance that never joined.
        expect([503, 404], `${method} ${spelling} must not reach a peer handler`).toContain(response.status)
      }
    }
  })

  test("🔴 the airgap closes the same doors, through the same spellings", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    // ⚠️ Set BEFORE the graph is built: the policy is installed when the Offline layer builds, so an
    // airgap engaged afterwards would be overwritten by the app's own build and the test would pass
    // for the wrong reason (never-consented, not airgapped).
    process.env["NOVACLAW_OFFLINE"] = "true"
    const server = app()
    // Consented AND switched on, so the ONLY thing left to refuse is the airgap — the case the
    // previous guard was written for and the one the aliases walked around.
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: true })

    for (const [key, path] of Object.entries(CommunityPeerPaths)) {
      const method = METHOD[key as keyof typeof CommunityPeerPaths]
      for (const spelling of [path, ...aliasesOf(path)]) {
        const response = await send(server, method, spelling, tmp.path)
        await cancelBody(response)
        expect([503, 404], `${method} ${spelling} must be closed while airgapped`).toContain(response.status)
      }
    }
  })

  test("🔴 with consent given and no airgap the doors OPEN — the control that matters", async () => {
    // A gate that simply broke these endpoints would pass both tests above and kill the network.
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })

    for (const [key, path] of Object.entries(CommunityPeerPaths)) {
      const method = METHOD[key as keyof typeof CommunityPeerPaths]
      const response = await send(server, method, path, tmp.path)
      await cancelBody(response)
      expect(response.status, `${method} ${path} must answer a peer once we have joined`).not.toBe(503)
    }
  })

  test("🔴 the 256 KB cap holds on the alias spellings too", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })

    // A declared length over the cap, without sending the bytes: the point of the check is that it
    // decides BEFORE anything is read, so an honest content-length is all it needs.
    const oversized = "x".repeat(64)
    for (const spelling of [CommunityPeerPaths.ask, ...aliasesOf(CommunityPeerPaths.ask)]) {
      const response = await server.request(spelling, {
        method: "POST",
        headers: {
          "x-novaclaw-directory": tmp.path,
          "content-type": "application/json",
          "content-length": String(MAX_PEER_REQUEST_BYTES + 1),
        },
        body: oversized,
      })
      await cancelBody(response)
      expect([413, 404], `POST ${spelling} over the cap must be refused before it is read`).toContain(response.status)
    }

    // The control: a legitimate body is not capped.
    const fine = await send(server, "POST", CommunityPeerPaths.ask, tmp.path)
    await cancelBody(fine)
    expect(fine.status).not.toBe(413)
  })

  test("🔴 the OWNER's own API is never gated, joined or not", async () => {
    /**
     * The airgap withdraws a choice to talk to the NETWORK. An airgap that locked the user out of
     * their own message history would be a data-loss bug wearing a security feature's clothes.
     *
     * ⚠️ `/api/community/offer/mine` is named because the previous gate DID break it: the panel read
     * the peer path `/api/community/offer`, so an airgapped user could not see their own
     * advertisement, and the test of the day passed because it listed only app paths.
     */
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    CommunityConsent.applied({ consented: false, enabled: false }, { enabled: true })

    for (const path of [
      "/api/community/channel/%23bread/history",
      "/api/community/contact",
      "/api/community/offer/mine",
      "/api/session",
    ]) {
      const response = await server.request(path, { headers: { "x-novaclaw-directory": tmp.path } })
      await cancelBody(response)
      expect(response.status, `${path} belongs to the owner and must not be gated`).not.toBe(503)
    }
  })
})
