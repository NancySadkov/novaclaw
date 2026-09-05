import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { Flag } from "@novaclaw/core/flag/flag"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@novaclaw/core/fs-util"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
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
// packaged binaries) and no remote fallback by design. The root serves the API explainer;
// other unmatched GETs are 404. Auth semantics remain observable because unauthorized
// requests get 401 before either response.
function uiApp(input?: {
  password?: string
  username?: string
  disableEmbeddedWebUi?: boolean
  embeddedWebUI?: Record<string, string>
  fs?: FSUtil.Interface
}) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.createUIRoute(input?.embeddedWebUI).pipe(
      Layer.provide([
        input?.fs ? Layer.succeed(FSUtil.Service)(input.fs) : FSUtil.defaultLayer,
        RuntimeFlags.layer({ disableEmbeddedWebUi: input?.disableEmbeddedWebUi ?? false }),
        Layer.mock(SettingsConfigStore.Service)({
          serverPassword: () => Effect.succeed(undefined),
        }),
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
        yield* router.add("GET", "/*", (request) =>
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
  it.live("serves the API explainer at root when no embedded UI is present", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({ disableEmbeddedWebUi: true }).request("/")

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(yield* responseText(response)).toContain("NovaClaw API")
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

  it.live("serves an embedded SPA fallback only to safe page methods", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const server = uiApp({
        embeddedWebUI: { "index.html": "/$bunfs/root/index.html" },
        fs: {
          ...fs,
          readFile: (path) =>
            path === "/$bunfs/root/index.html"
              ? Effect.succeed(new TextEncoder().encode("<html>embedded novaclaw</html>"))
              : Effect.die(`unexpected embedded UI path: ${path}`),
        },
      })

      for (const method of ["GET", "HEAD"]) {
        const response = yield* server.request("/deleted-route", { method })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
      }

      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = yield* server.request("/deleted-route", { method })
        expect(response.status).toBe(404)
        expect(response.headers.get("content-type") ?? "").not.toContain("text/html")
        expect(yield* responseText(response)).not.toContain("embedded novaclaw")
      }
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

      // Auth accepted: the request reaches the API explainer, not the 401 middleware response.
      expect(response.status).toBe(200)
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

      expect(response.status).toBe(200)
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

      expect(response.status).toBe(200)
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

/**
 * ─── the embedded UI must be CACHEABLE, and index.html must not be ───────────────────────────────
 *
 * 🔴 Until 2026-08-18 the only header on a served asset was `content-type` — no `Cache-Control`, no
 * validator. A response with neither gives the browser nothing to revalidate against and no freshness
 * to trust, so returning to a screen re-requested its images and the server re-read each one from disk
 * with a fresh `fs.readFile`. `public/assets` is 3.5 MB, 476 KB of it home-screen tiles, on the one
 * surface a user navigates back to constantly.
 *
 * ⚠️ The tiers are the whole point, and the HTML one would be a BUG to get wrong: the document names
 * the build-hashed chunks, so a cached shell after an upgrade points at filenames that no longer
 * exist. `no-cache` means "always ask", not "do not store" — the ETag still turns that ask into a 304.
 */
describe("embedded UI caching", () => {
  const serve = (path: string, file: string, body: string, ifNoneMatch?: string) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return yield* serveEmbeddedUIEffect(
        path,
        { ...fs, readFile: () => Effect.succeed(new TextEncoder().encode(body)) },
        { [path.replace(/^\//, "")]: file },
        ifNoneMatch,
      ).pipe(Effect.map(HttpServerResponse.toWeb))
    })

  it.live("a build-hashed asset is immutable — its name IS its version", () =>
    Effect.gen(function* () {
      const response = yield* serve("/assets/index-a1b2c3d4e5.js", "/$bunfs/root/assets/index-a1b2c3d4e5.js", "x=1")
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(response.headers.get("etag")).toBeTruthy()
    }),
  )

  it.live("🔴 a STABLE-named asset is cacheable but never immutable", () =>
    Effect.gen(function* () {
      // The home-screen tiles ship under stable names. `immutable` would pin a stale image in every
      // client's cache for a year with no way to push a correction.
      const response = yield* serve("/assets/skin/tiles/notes.png", "/$bunfs/root/assets/skin/tiles/notes.png", "png")
      const cacheControl = response.headers.get("cache-control")
      expect(cacheControl).toContain("max-age=3600")
      expect(cacheControl).not.toContain("immutable")
    }),
  )

  it.live("🔴 index.html is NEVER cached — a stale shell names chunks that no longer exist", () =>
    Effect.gen(function* () {
      const response = yield* serve("/", "/$bunfs/root/index.html", "<!doctype html><title>x</title>")
      expect(response.headers.get("cache-control")).toBe("no-cache")
      // …but it still carries a validator, so the always-ask costs a 304 rather than a full body.
      expect(response.headers.get("etag")).toBeTruthy()
      expect(response.headers.get("content-security-policy")).toBeTruthy()
    }),
  )

  it.live("a matching If-None-Match is answered 304 with no body", () =>
    Effect.gen(function* () {
      const first = yield* serve("/assets/skin/tiles/notes.png", "/$bunfs/root/assets/skin/tiles/notes.png", "png")
      const etag = first.headers.get("etag")!
      const second = yield* serve(
        "/assets/skin/tiles/notes.png",
        "/$bunfs/root/assets/skin/tiles/notes.png",
        "png",
        etag,
      )
      expect(second.status).toBe(304)
      expect(yield* responseText(second)).toBe("")
      expect(second.headers.get("etag")).toBe(etag)
    }),
  )

  it.live("reads and hashes one immutable embedded asset once per generated asset map", () =>
    Effect.gen(function* () {
      const base = yield* FSUtil.Service
      let reads = 0
      const fs = { ...base, readFile: () => Effect.sync(() => (reads++, new TextEncoder().encode("png"))) }
      const embedded = { "assets/skin/tiles/notes.png": "/$bunfs/root/assets/skin/tiles/notes.png" }
      yield* serveEmbeddedUIEffect("/assets/skin/tiles/notes.png", fs, embedded)
      yield* serveEmbeddedUIEffect("/assets/skin/tiles/notes.png", fs, embedded)
      expect(reads).toBe(1)
    }),
  )

  it.live("a STALE If-None-Match still gets the body — the validator is over the bytes", () =>
    Effect.gen(function* () {
      const response = yield* serve(
        "/assets/skin/tiles/notes.png",
        "/$bunfs/root/assets/skin/tiles/notes.png",
        "different bytes",
        '"not-the-right-etag"',
      )
      expect(response.status).toBe(200)
      expect(yield* responseText(response)).toBe("different bytes")
    }),
  )

  it.live("the ETag follows the CONTENT, not the filename", () =>
    Effect.gen(function* () {
      // Hashing the body rather than stat'ing the file is deliberate: the UI is baked into the binary,
      // so mtime describes the install, and two installs of one build must agree.
      const a = yield* serve("/assets/skin/tiles/notes.png", "/$bunfs/root/assets/skin/tiles/notes.png", "one")
      const b = yield* serve("/assets/skin/tiles/notes.png", "/$bunfs/root/assets/skin/tiles/notes.png", "two")
      expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"))
    }),
  )
})
