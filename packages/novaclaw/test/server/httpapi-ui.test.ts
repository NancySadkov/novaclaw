import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { Flag } from "@novaclaw/core/flag/flag"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@novaclaw/core/fs-util"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { serveEmbeddedUIEffect, serveUIEffect } from "../../src/server/shared/ui"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      NOVACLAW_SERVER_PASSWORD: Flag.NOVACLAW_SERVER_PASSWORD,
      NOVACLAW_SERVER_USERNAME: Flag.NOVACLAW_SERVER_USERNAME,
      envPassword: process.env.NOVACLAW_SERVER_PASSWORD,
      envUsername: process.env.NOVACLAW_SERVER_USERNAME,
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.NOVACLAW_SERVER_PASSWORD = original.NOVACLAW_SERVER_PASSWORD
        Flag.NOVACLAW_SERVER_USERNAME = original.NOVACLAW_SERVER_USERNAME
        restoreEnv("NOVACLAW_SERVER_PASSWORD", original.envPassword)
        restoreEnv("NOVACLAW_SERVER_USERNAME", original.envUsername)
      }),
    )
  }),
)

const it = testEffect(Layer.mergeAll(testStateLayer, FSUtil.defaultLayer, RuntimeFlags.layer()))

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

function app(input?: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            NOVACLAW_SERVER_PASSWORD: input?.password,
            NOVACLAW_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

// There is no embedded web UI in the test build (novaclaw-web-ui.gen.ts only exists in
// packaged binaries) and no remote fallback by design, so an authorized request to the
// UI catch-all resolves to a plain 404. Auth semantics are still observable: unauthorized
// requests get 401 before the route runs.
function uiApp(input?: { password?: string; username?: string; disableEmbeddedWebUi?: boolean }) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const flags = yield* RuntimeFlags.Service
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide(authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))),
      Layer.provide([
        FSUtil.defaultLayer,
        RuntimeFlags.layer({ disableEmbeddedWebUi: input?.disableEmbeddedWebUi ?? false }),
        HttpServer.layerServices,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            NOVACLAW_SERVER_PASSWORD: input?.password,
            NOVACLAW_SERVER_USERNAME: input?.username,
          }),
        ),
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

function routeOrderingApp() {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const flags = yield* RuntimeFlags.Service
        yield* router.add("GET", "/session/:sessionID", () =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ matched: "api-route" }, { status: 200 })),
        )
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide([
        FSUtil.defaultLayer,
        RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
        HttpServer.layerServices,
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
}

function responseText(response: Response) {
  return Effect.promise(() => response.text())
}

describe("HttpApi UI fallback", () => {
  it.live("returns 404 from the UI catch-all when no embedded UI is present", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({ disableEmbeddedWebUi: true }).request("/")

      expect(response.status).toBe(404)
      expect(yield* responseText(response)).toContain("Not Found")
    }),
  )

  it.live("serves embedded UI assets when Bun can read them but access reports missing", () =>
    Effect.gen(function* () {
      let readPath: string | undefined

      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedUIEffect(
        "/assets/app.js",
        {
          ...fs,
          existsSafe: () => Effect.die("embedded UI should not rely on filesystem access checks"),
          readFile: (path) => {
            readPath = path
            return path === "/$bunfs/root/assets/app.js"
              ? Effect.succeed(new TextEncoder().encode("console.log('embedded')"))
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "assets/app.js": "/$bunfs/root/assets/app.js" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(readPath).toBe("/$bunfs/root/assets/app.js")
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(yield* responseText(response)).toBe("console.log('embedded')")
    }),
  )

  it.live("allows embedded UI terminal wasm and theme preload CSP", () =>
    Effect.gen(function* () {
      const script = 'document.documentElement.dataset.theme = "dark"'

      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedUIEffect(
        "/",
        {
          ...fs,
          readFile: (path) => {
            return path === "/$bunfs/root/index.html"
              ? Effect.succeed(
                  new TextEncoder().encode(
                    `<html><head><script id="oc-theme-preload-script">${script}</script></head></html>`,
                  ),
                )
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "index.html": "/$bunfs/root/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      const csp = response.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
      expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`)
      expect(csp).toContain("connect-src * data:")
    }),
  )

  it.live("serves the SPA index for unknown paths when the embedded UI is present", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedUIEffect(
        "/status",
        {
          ...fs,
          readFile: (path) =>
            path === "/$bunfs/root/index.html"
              ? Effect.succeed(new TextEncoder().encode("<html>novaclaw</html>"))
              : Effect.die(`unexpected embedded UI path: ${path}`),
        },
        { "index.html": "/$bunfs/root/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(yield* responseText(response)).toBe("<html>novaclaw</html>")
    }),
  )

  it.live("keeps matched API routes ahead of the UI fallback", () =>
    Effect.gen(function* () {
      const server = routeOrderingApp()
      const response = yield* server.request("/session/ses_nope")

      expect(response.status).toBe(200)
      expect(yield* responseText(response)).toContain("api-route")
    }),
  )

  it.live("requires server password for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "novaclaw",
        disableEmbeddedWebUi: true,
      }).request("/")

      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
    }),
  )

  it.live("accepts auth token for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "novaclaw",
        disableEmbeddedWebUi: true,
      }).request(`/?auth_token=${btoa("novaclaw:secret")}`)

      // Auth accepted: the request reaches the route (404 without an embedded UI), not 401.
      expect(response.status).toBe(404)
    }),
  )

  it.live("accepts basic auth for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "secret",
        username: "novaclaw",
        disableEmbeddedWebUi: true,
      }).request("/", {
        headers: { authorization: `Basic ${btoa("novaclaw:secret")}` },
      })

      expect(response.status).toBe(404)
    }),
  )

  it.live("accepts basic auth passwords containing colons for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({
        password: "sec:ret",
        username: "novaclaw",
        disableEmbeddedWebUi: true,
      }).request("/", {
        headers: { authorization: `Basic ${btoa("novaclaw:sec:ret")}` },
      })

      expect(response.status).toBe(404)
    }),
  )

  // Regression for #25698 (Ope): the browser fetches the PWA manifest and
  // its icons via flows that don't carry app-managed credentials (the
  // `<link rel="manifest">` request is not under page-auth control), so the
  // server returning 401 breaks PWA install. These specific public assets
  // should bypass auth.
  it.live("serves the PWA manifest without auth even when a server password is set", () =>
    Effect.gen(function* () {
      for (const path of ["/site.webmanifest", "/web-app-manifest-192x192.png", "/web-app-manifest-512x512.png"]) {
        const response = yield* uiApp({
          password: "secret",
          username: "novaclaw",
          disableEmbeddedWebUi: true,
        }).request(path)
        expect(response.status).not.toBe(401)
      }
    }),
  )

  it.live("allows web UI preflight without auth", () =>
    Effect.gen(function* () {
      const response = yield* app({ password: "secret", username: "novaclaw" }).request("/", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
        },
      })

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    }),
  )
})
