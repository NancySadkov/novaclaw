import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { PtyPaths } from "@novaclaw/protocol/groups/pty"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { PtyID } from "@novaclaw/core/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function app(input: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            NOVACLAW_SERVER_PASSWORD: input.password,
            NOVACLAW_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  // The consent gate is process-wide: a test that opens the peer door must close it again, or the
  // next file's "never consented" case is silently testing a joined instance.
  CommunityConsent.resetGate()
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi instance route authorization", () => {
  test("requires configured auth before opening the instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app({ password: "secret" })
    const headers = { "x-novaclaw-directory": tmp.path }

    const missing = await server.request("/api/event", { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request("/api/event", {
      headers: { ...headers, authorization: basic("novaclaw", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  /**
   * 🔴 The community peer paths are the ONE surface in this product that must answer a stranger, and
   * nothing ran them against a server with a password until now.
   *
   * The static guard (`httpapi-public-openapi.test.ts`) proves what the API DECLARES. This proves
   * what a running server ENFORCES, and they are different claims — a control can be declared
   * correctly and never execute. It failed to be obvious because every probe of this subsystem ran
   * against instances started WITHOUT `NOVACLAW_SERVER_PASSWORD`, where every path answers 200 and an
   * unauthenticated endpoint is indistinguishable from an authenticated one.
   *
   * ⚠️ Both directions matter and the first is the one people forget: if a peer path ever starts
   * demanding auth, PEERS SILENTLY STOP REACHING THIS INSTANCE — the network feature dies quietly
   * while every screen still works for its owner.
   */
  test("🔴 community PEER paths stay reachable without credentials, and the rest do not", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app({ password: "secret" })
    const headers = { "x-novaclaw-directory": tmp.path }

    /**
     * ⚠️ The METHOD matters and cost a false failure to learn: a GET on a POST-only peer path does
     * not match the route, falls through to an authenticated handler, and answers 401 — which reads
     * exactly like "this peer path demands credentials". With the right method every one answers 400
     * (the empty body fails its schema) and never 401, which is the property under test.
     *
     * The map is keyed to `CommunityPeerPaths` and asserted complete below, so a peer endpoint added
     * later fails here until somebody states its method — derived, never hand-listed.
     */
    const METHOD: Record<keyof typeof CommunityPeerPaths, "GET" | "POST"> = {
      inbound: "POST",
      syncSummary: "POST",
      syncIds: "POST",
      syncMessages: "POST",
      search: "POST",
      dm: "POST",
      peers: "GET",
      listedChannels: "GET",
      succession: "GET",
      offer: "GET",
      // Added when bootstrap-by-address turned out to probe an AUTHENTICATED path; the completeness
      // assertion below is what forced this line to be written rather than the path slipping in.
      identity: "GET",
      /**
       * 🔴 Unauthenticated like every peer path, and that is the DECISION rather than an
       * oversight: a stranger with no credentials is exactly who this is for — an agent asking the
       * other agents because a site closed itself to it.
       *
       * ⚠️ What stops it being an open cost is not authentication but the gate behind it: off
       * unless the owner turned it on separately from joining, a daily count, a per-asker share, and
       * one turn at a time. Requiring credentials instead would make it useless for its purpose and
       * would not bound the cost any better.
       */
      ask: "POST",
    }
    expect(Object.keys(METHOD).sort()).toEqual(Object.keys(CommunityPeerPaths).sort())

    /**
     * 🔴 **This half was VACUOUS until 2026-08-17 (review finding 1.19), in two ways at once.**
     *
     * The fixture's database has never consented, so every peer path answered **503 at the peer
     * door before `Authorization` could run** — observed for all twelve. And an in-process `Request`
     * carries no `content-length`, so every peer POST was refused **413** by the size cap. Both are
     * ≠ 401, so the assertion below passed while testing nothing about authorization: a peer door
     * that started demanding credentials would have been invisible here.
     *
     * So the door is OPENED first, and the assertion is now on the status a peer actually receives —
     * `400`, its empty body failing the endpoint's own schema. That is a status only reachable
     * THROUGH the auth boundary, which is what makes the check able to fail.
     */
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })

    for (const [key, route] of Object.entries(CommunityPeerPaths)) {
      const method = METHOD[key as keyof typeof CommunityPeerPaths]
      const anonymous = await server.request(route, {
        method,
        headers:
          method === "POST" ? { ...headers, "content-type": "application/json", "content-length": "2" } : headers,
        ...(method === "POST" ? { body: "{}" } : {}),
      })
      await cancelBody(anonymous)
      expect(anonymous.status, `${method} ${route} must not demand credentials — peers cannot supply them`).not.toBe(
        401,
      )
      // ⚠️ The positive half: it REACHED its handler. Without this the test is satisfied by any
      // refusal that happens to differ from 401 — which is exactly how it went green for a year.
      expect(anonymous.status, `${method} ${route} must reach its handler, not a gate`).toBeLessThan(500)
      expect(
        [400, 200, 404].includes(anonymous.status),
        `${method} ${route} answered ${anonymous.status}; a peer door answers its own schema, not a guard`,
      ).toBe(true)
    }

    // ⚠️ The other direction, on the paths that carry the OWNER's data. `offers` is the one that
    // matters most: it re-verifies every stored offer, so if it were public a stranger would get an
    // expensive read AND the user's collected advertisements.
    for (const route of ["/api/community/offers", "/api/community/offer/mine", "/api/community/contact"]) {
      const anonymous = await server.request(route, { method: "GET", headers })
      await cancelBody(anonymous)
      expect(anonymous.status, `${route} carries the owner's data and must demand credentials`).toBe(401)

      const authed = await server.request(route, {
        method: "GET",
        headers: { ...headers, authorization: basic("novaclaw", "secret") },
      })
      await cancelBody(authed)
      expect(authed.status, `${route} must answer its own owner`).not.toBe(401)
    }
  })

  test("requires configured auth before resolving the PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-novaclaw-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("novaclaw", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })
})
