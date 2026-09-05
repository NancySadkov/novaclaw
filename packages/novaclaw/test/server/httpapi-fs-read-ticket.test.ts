import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import path from "path"
import fs from "fs/promises"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Location } from "@novaclaw/core/location"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { ServerAuth as V2ServerAuth } from "@novaclaw/server/auth"
import { authorizationLayer as serverAuthorizationLayer } from "@novaclaw/server/middleware/authorization"
import { Ticket, TICKET_QUERY, TICKET_REQUEST_HEADER } from "@novaclaw/schema/ticket"
import { ServerAuthorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * 🔴 **THE ONE ROUTE A BROWSER FETCHES FOR ITSELF, AND THE ONLY THING THAT AUTHORIZES IT.**
 *
 * A `<a download>` href is fetched by the browser, and a browser-issued request carries no
 * `Authorization` header — so on any instance with a server password the chat's file links and the
 * Files browser's Download saved the 401 body under the file's own name. `POST /api/fs/read-token`
 * mints a short-lived single-use ticket, the authorization middleware admits a `/api/fs/read/*`
 * request that presents one, and this handler is then obliged to spend it.
 *
 * ⚠️ **Admission is not authorization, and the gap between the two is the whole risk.** The
 * middleware only checks that a ticket parameter is THERE. If the handler read it and shrugged,
 * `?ticket=anything` would be an unauthenticated read of any file on the host — a worse bug than
 * the one being fixed. So the cases below are not "it works": a forged ticket, a spent ticket and a
 * ticket for a different file must each be refused, and a ticket must not widen any other route.
 *
 * ⚠️ **EXPIRY is asserted where the clock is**, in `packages/core/test/ticket.test.ts`, which
 * shortens the TTL to 5 ms and watches a ticket die. Nothing between here and there can shorten it,
 * and a 60 s wait in an HTTP suite is a hang backstop waiting to happen.
 */

const context = Context.empty() as Context.Context<unknown>

const call = (route: string, directory: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set("x-novaclaw-directory", directory)
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { ...init, headers }), context)
}

const location = (directory: string) => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`

const mint = async (directory: string, name: string): Promise<Response> =>
  call(`/api/fs/read-token?${location(directory)}&path=${encodeURIComponent(name)}`, directory, {
    method: "POST",
    headers: { [TICKET_REQUEST_HEADER]: "1" },
  })

const ticketFrom = async (response: Response): Promise<string> => {
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(Location.response(Ticket.AccessToken))(await response.json()).data.ticket
}

const read = (directory: string, name: string, ticket?: string) =>
  call(
    `/api/fs/read/${encodeURIComponent(name)}?${location(directory)}${ticket ? `&${TICKET_QUERY}=${ticket}` : ""}`,
    directory,
  )

const CONTENT = "a colleague's report\n"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("a file read ticket", () => {
  test("🔴 works ONCE, and the second use of the same ticket is refused", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    await fs.writeFile(path.join(tmp.path, "report.md"), CONTENT)

    const ticket = await ticketFrom(await mint(tmp.path, "report.md"))

    const first = await read(tmp.path, "report.md", ticket)
    expect(first.status).toBe(200)
    expect(await first.text()).toBe(CONTENT)

    const second = await read(tmp.path, "report.md", ticket)
    expect(second.status, "a single-use ticket was spendable twice").toBe(403)
  })

  test("🔴 a ticket nobody minted is refused — the middleware's admission is not authorization", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    await fs.writeFile(path.join(tmp.path, "report.md"), CONTENT)

    const forged = await read(tmp.path, "report.md", "00000000-0000-4000-8000-000000000000")
    expect(forged.status).toBe(403)
    expect(await forged.text()).not.toContain("colleague")
  })

  test("🔴 a ticket for one file does not read another in the same directory", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    await fs.writeFile(path.join(tmp.path, "public.md"), CONTENT)
    await fs.writeFile(path.join(tmp.path, "secrets.env"), "TOKEN=hunter2\n")

    const ticket = await ticketFrom(await mint(tmp.path, "public.md"))

    const crossed = await read(tmp.path, "secrets.env", ticket)
    expect(crossed.status).toBe(403)
    expect(await crossed.text()).not.toContain("hunter2")

    // ⚠️ Control: the ticket was still good, so the refusal above was about the FILE and not about
    // a ticket that had already gone stale for some unrelated reason.
    const allowed = await read(tmp.path, "public.md", ticket)
    expect(allowed.status).toBe(200)
  })

  test("🔴 a ticket minted for one directory does not read the same name in another", async () => {
    await using here = await tmpdir({ git: true, config: { formatter: false } })
    await using there = await tmpdir({ git: true, config: { formatter: false } })
    await fs.writeFile(path.join(here.path, "notes.md"), CONTENT)
    await fs.writeFile(path.join(there.path, "notes.md"), "somebody else's\n")

    const ticket = await ticketFrom(await mint(here.path, "notes.md"))

    expect((await read(there.path, "notes.md", ticket)).status).toBe(403)
    expect((await read(here.path, "notes.md", ticket)).status).toBe(200)
  })

  test("minting requires the header that forces a CORS preflight", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const bare = await call(`/api/fs/read-token?${location(tmp.path)}&path=report.md`, tmp.path, { method: "POST" })
    expect(bare.status).toBe(403)
  })

  /**
   * ⚠️ CONTROLS. Without them every refusal above is also produced by a route that refuses
   * everything, and by one that never streams a file at all.
   */
  test("control: the same read without any ticket still works when no password is set", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    await fs.writeFile(path.join(tmp.path, "report.md"), CONTENT)

    const response = await read(tmp.path, "report.md")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(CONTENT)
  })

  /**
   * 🔴 THE RESPONSE IS STILL BYTES ON THE WIRE.
   *
   * The whole reason the download half could not take the chat images' answer is that a large
   * artefact must never have to fit in a JS string. A handler that started base64-ing the body
   * would move that cost one layer down where no client could see it — so the body is asserted to
   * be the file's own bytes, byte for byte, with no JSON envelope and no re-encoding.
   */
  test("🔴 control: a ticketed read returns the raw bytes, not an encoded envelope", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251)
    await fs.writeFile(path.join(tmp.path, "chart.bin"), bytes)

    const ticket = await ticketFrom(await mint(tmp.path, "chart.bin"))
    const response = await read(tmp.path, "chart.bin", ticket)

    expect(response.status).toBe(200)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.length).toBe(bytes.length)
    expect([...body]).toEqual([...bytes])
    expect(response.headers.get("content-type") ?? "").not.toContain("application/json")
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The middleware's half, driven against a REAL server password.
//
// The suite above runs without one, because that is what the fixture instance has — so it proves the
// handler spends tickets but says nothing about the admission rule that makes the ticket necessary.
// This mounts the real `@novaclaw/server` authorization middleware over probes at the real paths.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const Api = HttpApi.make("test-fs-ticket").add(
  HttpApiGroup.make("test.fs")
    .add(
      HttpApiEndpoint.get("read", "/api/fs/read/*", { success: Schema.String }),
      // The route a ticket must NOT widen: same surface, same middleware, a different path.
      HttpApiEndpoint.get("other", "/api/session", { success: Schema.String }),
      // The mint route itself is credential-gated like everything else — a browser is not the one
      // asking for it, the app's authenticated client is.
      HttpApiEndpoint.post("token", "/api/fs/read-token", { success: Schema.String }),
    )
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test.fs", (handlers) =>
  handlers
    .handle("read", () => Effect.succeed("bytes"))
    .handle("other", () => Effect.succeed("other"))
    .handle("token", () => Effect.succeed("minted")),
)

const noStoredTokenLayer = Layer.succeed(
  SettingsConfigStore.Service,
  SettingsConfigStore.Service.of({
    all: () => Effect.succeed({}),
    serverPassword: () => Effect.succeed(undefined),
    set: () => Effect.void,
    update: () => Effect.void,
    remove: () => Effect.void,
    unreadable: () => Effect.succeed([]),
    isEmpty: () => Effect.succeed(true),
  }),
)

const it = testEffect(
  HttpRouter.serve(HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(serverAuthorizationLayer)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(V2ServerAuth.Config.layer({ password: Option.some("secret"), username: "novaclaw" })),
    Layer.provide(noStoredTokenLayer),
  ),
)

describe("what the authorization middleware admits on a password-protected instance", () => {
  it.live("refuses the download route with no credential and no ticket", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/fs/read/report.md")
      expect(response.status).toBe(401)
    }),
  )

  it.live("🔴 admits it when a ticket is presented — the handler is what spends it", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/api/fs/read/report.md?${TICKET_QUERY}=anything`)
      expect(response.status).toBe(200)
    }),
  )

  it.live("🔴 the same ticket parameter does NOT widen any other route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/api/session?${TICKET_QUERY}=anything`)
      expect(response.status).toBe(401)
    }),
  )

  it.live("🔴 minting still needs the credential — a ticket cannot bootstrap itself", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(`/api/fs/read-token?${TICKET_QUERY}=anything`)
      expect(response.status).toBe(401)
    }),
  )

  it.live("an empty ticket parameter is not a ticket", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/api/fs/read/report.md?${TICKET_QUERY}=`)
      expect(response.status).toBe(401)
    }),
  )

  it.live("a request that names no file is not this route", () =>
    Effect.gen(function* () {
      // `/api/fs/read/` with nothing after it has no file to scope a ticket to, so admitting it
      // would be admitting a request the handler could not have minted a ticket for.
      const response = yield* HttpClient.get(`/api/fs/read/?${TICKET_QUERY}=anything`)
      expect(response.status).not.toBe(200)
    }),
  )
})
