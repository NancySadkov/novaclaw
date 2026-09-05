import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { ServerAuth } from "../../src/server/auth"
import {
  AUTH_TOKEN_QUERY,
  Authorization,
  authorizationLayer,
  authorizationRouterMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

/**
 * Which CHANNEL may carry this instance's password.
 *
 * The typed HttpApi surface is the one `workspaceProxyURL` forwards to another machine, and it
 * copies the request's whole query string into the outbound URL. So long as a query parameter was
 * ALSO a credential there, an ordinary proxied request carried the local password to a host that is
 * not ours — the data plane egressing on a request the user never aimed at anyone.
 *
 * Every client of that surface can set a header (the SDK and the app both do). One caller cannot:
 * the desktop hands the web UI off by navigating a browser to `/?auth_token=…`, and a top-level
 * navigation has no header to set. That surface is the raw router, which declares no workspace
 * routing and is therefore never proxied.
 *
 * These tests pin the asymmetry from both sides: the typed API must refuse the URL form even when
 * the credential in it is correct, and the navigation surface must still accept it, or the desktop
 * handoff is broken instead of secured.
 */

const Api = HttpApi.make("test-url-credential").add(
  HttpApiGroup.make("test")
    .add(HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }))
    .middleware(Authorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) => handlers.handle("probe", () => Effect.succeed("ok")))

const secretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "novaclaw" })

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

// The typed surface: the one that carries `WorkspaceRoutingMiddleware` in production and is proxied.
const typedApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

// The navigation surface: a raw router route, the same shape `createUIRoute` and `/doc` use.
const navigationLayer = HttpRouter.serve(
  HttpRouter.use((router) =>
    router.add("GET", "/ui-document", () => Effect.succeed(HttpServerResponse.text("document"))),
  ).pipe(Layer.provide(authorizationRouterMiddleware.layer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const itTyped = testEffect(typedApiLayer.pipe(Layer.provide(secretLayer), Layer.provide(noStoredTokenLayer)))
const itNavigation = testEffect(navigationLayer.pipe(Layer.provide(secretLayer), Layer.provide(noStoredTokenLayer)))

const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")
const basic = (username: string, password: string) => `Basic ${token(username, password)}`
const withToken = (route: string, username: string, password: string) =>
  `${route}?${AUTH_TOKEN_QUERY}=${encodeURIComponent(token(username, password))}`

describe("a credential in the URL", () => {
  itTyped.live("is refused by the typed API even when the credential itself is correct", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(withToken("/probe", "novaclaw", "secret"))

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
    }),
  )

  itTyped.live("cannot rescue a wrong header on the typed API", () =>
    Effect.gen(function* () {
      // The query form used to take PRECEDENCE over the header, so this combination authorized.
      const response = yield* HttpClientRequest.get(withToken("/probe", "novaclaw", "secret")).pipe(
        HttpClientRequest.setHeader("authorization", basic("novaclaw", "wrong")),
        HttpClient.execute,
      )

      expect(response.status).toBe(401)
    }),
  )

  itTyped.live("control: the same credential in the header still authorizes the typed API", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/probe").pipe(
        HttpClientRequest.setHeader("authorization", basic("novaclaw", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itNavigation.live("control: the browser-navigation surface still accepts it, or the desktop handoff breaks", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(withToken("/ui-document", "novaclaw", "secret"))

      expect(response.status).toBe(200)
    }),
  )

  itNavigation.live("control: the navigation surface still accepts a header", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/ui-document").pipe(
        HttpClientRequest.setHeader("authorization", basic("novaclaw", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
    }),
  )

  itNavigation.live("control: a wrong URL credential is still refused on the navigation surface", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(withToken("/ui-document", "novaclaw", "wrong"))

      expect(response.status).toBe(401)
    }),
  )
})
