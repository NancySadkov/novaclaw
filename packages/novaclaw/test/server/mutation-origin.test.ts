import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { refusesMutation } from "../../src/server/routes/instance/httpapi/middleware/mutation-origin"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

/**
 * 🔴 P2P review 2026-08-17, finding 1.18 — the CSRF shape on a default no-password install.
 *
 * Measured live: `POST /api/community/channel` with `Origin: https://evil.example` and NO
 * content-type answered **200**, and `#csrf-live` appeared in the channel list. Effect's payload
 * decoder treats a missing content-type as JSON, and its CORS middleware only withholds the response
 * header — the write had already happened.
 *
 * ⚠️ The route-level test is the one that matters, and the negative control below is the reason:
 * a guard that refused everything would pass the first assertion and break the product for every
 * peer, SDK client and `curl` caller, none of which send an `Origin` at all.
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

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("a mutation from a foreign Origin is refused (p2p 1.18)", () => {
  test("🔴 the exact probe from the review: a cross-origin join with no content-type", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    const response = await server.request("/api/community/channel", {
      method: "POST",
      // No content-type — that is the whole trick: it makes this a "simple" request a page may send.
      headers: { "x-novaclaw-directory": tmp.path, origin: "https://evil.example" },
      body: JSON.stringify({ name: "#csrf-live" }),
    })
    await cancelBody(response)
    expect(response.status).toBe(403)

    // …and it must not have joined anything on the way to being refused.
    const channels = await server.request("/api/community/channel", {
      headers: { "x-novaclaw-directory": tmp.path },
    })
    const names = ((await channels.json()) as ReadonlyArray<{ name: string }>).map((c) => c.name)
    expect(names).not.toContain("#csrf-live")
  })

  test("🔴 every other route the review named answers the same way", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    const headers = { "x-novaclaw-directory": tmp.path, origin: "https://evil.example" }
    for (const [method, path] of [
      ["POST", "/api/community/rotate"],
      ["POST", "/api/community/channel/%23bread/post"],
      ["PATCH", "/config"],
      ["POST", "/api/session"],
    ] as const) {
      const response = await server.request(path, { method, headers, body: "{}" })
      await cancelBody(response)
      expect(response.status, `${method} ${path} must refuse a foreign origin`).toBe(403)
    }
  })

  test("🔴 the controls: no Origin, same host, and the UI's own origins all still write", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()

    // A peer, the SDK and curl send NO Origin. Refusing them would break the network to stop an
    // attack none of them can mount — a browser cannot suppress its own Origin on a mutation.
    const anonymous = await server.request("/api/community/channel", {
      method: "POST",
      headers: { "x-novaclaw-directory": tmp.path, "content-type": "application/json" },
      body: JSON.stringify({ name: "#no-origin" }),
    })
    await cancelBody(anonymous)
    expect(anonymous.status).not.toBe(403)

    for (const origin of ["http://localhost:4096", "http://127.0.0.1:4096", "nc://renderer", "https://novaclaw.app"]) {
      const response = await server.request("/api/community/channel", {
        method: "POST",
        headers: { "x-novaclaw-directory": tmp.path, "content-type": "application/json", origin },
        body: JSON.stringify({ name: "#own-ui" }),
      })
      await cancelBody(response)
      expect(response.status, `${origin} is the product's own UI and must write`).not.toBe(403)
    }

    /**
     * ⚠️ The LAN case, and it needs an explicit `host` header to be real: a user reaching their
     * instance at `http://192.168.1.5:4096` sends that as both `Origin` and `Host`, which is what
     * `isAllowedRequestOrigin`'s same-host branch is for. In-process `Request`s carry no `host`
     * header at all, so without this line the branch would never execute here.
     */
    const lan = await server.request("/api/community/channel", {
      method: "POST",
      headers: {
        "x-novaclaw-directory": tmp.path,
        "content-type": "application/json",
        origin: "http://192.168.1.5:4096",
        host: "192.168.1.5:4096",
      },
      body: JSON.stringify({ name: "#lan" }),
    })
    await cancelBody(lan)
    expect(lan.status, "a user reaching their own instance over the LAN must write").not.toBe(403)

    // A READ from anywhere is untouched: this guard is about state changes, and a page that could
    // read cross-origin was never stopped by the response header being withheld anyway.
    const read = await server.request("/api/community/channel", {
      headers: { "x-novaclaw-directory": tmp.path, origin: "https://evil.example" },
    })
    await cancelBody(read)
    expect(read.status).not.toBe(403)
  })

  test("the decision itself: same-host and configured origins pass, a stranger does not", () => {
    const cors = { cors: ["https://team.example"] }
    expect(refusesMutation({ method: "POST", origin: "https://evil.example", host: "nova.local", cors })).toBe(true)
    expect(refusesMutation({ method: "POST", origin: "https://nova.local", host: "nova.local", cors })).toBe(false)
    expect(refusesMutation({ method: "POST", origin: "https://team.example", host: "nova.local", cors })).toBe(false)
    expect(refusesMutation({ method: "GET", origin: "https://evil.example", host: "nova.local", cors })).toBe(false)
    expect(refusesMutation({ method: "POST", origin: undefined, host: "nova.local", cors })).toBe(false)
  })
})
