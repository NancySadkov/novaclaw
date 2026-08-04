import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { ServerAuth as V2ServerAuth } from "@novaclaw/server/auth"
// The UNPAIRED layer, on purpose. Production imports `serverAuthorizationLayer` from the middleware
// module, which since 2026-07-28 arrives with `@novaclaw/server`'s own config already provided so no
// call site can pick the wrong one of the two `ServerAuth.Config` tags. A test that wants to INJECT a
// config therefore has to reach for the unconfigured layer at its own source — which is the one place
// where choosing a config is the caller's job.
import { authorizationLayer as serverAuthorizationLayer } from "@novaclaw/server/middleware/authorization"
import {
  Authorization,
  authorizationLayer,
  ServerAuthorization,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const Api = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("missing", "/missing", {
        success: Schema.String,
        error: HttpApiError.NotFound,
      }),
    )
    .middleware(Authorization),
)

const ServerApi = HttpApi.make("test-server-authorization").add(
  HttpApiGroup.make("test.v2")
    .add(
      HttpApiEndpoint.get("probe", "/api/probe", {
        success: Schema.String,
      }),
    )
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("missing", () => Effect.fail(new HttpApiError.NotFound({}))),
)

const serverHandlers = HttpApiBuilder.group(ServerApi, "test.v2", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const v2ApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(serverHandlers), Layer.provide(serverAuthorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const noAuthLayer = ServerAuth.Config.layer({ password: Option.none(), username: "novaclaw" })
const secretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "novaclaw" })
const kitSecretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "kit" })
// `serverAuthorizationLayer` comes from `@novaclaw/server`, so it needs THAT package's tag — a separate
// key since 2026-07-28 (U3). Providing the instance layer here used to satisfy it by id collision.
const v2SecretLayer = V2ServerAuth.Config.layer({ password: Option.some("secret"), username: "novaclaw" })

const it = testEffect(apiLayer.pipe(Layer.provide(noAuthLayer)))
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))
const itKitSecret = testEffect(apiLayer.pipe(Layer.provide(kitSecretLayer)))
const itV2Secret = testEffect(v2ApiLayer.pipe(Layer.provide(v2SecretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")

const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware", () => {
  it.live("allows requests when server password is not configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itSecret.live("requires configured password for basic auth", () =>
    Effect.gen(function* () {
      const [missing, badPassword, good] = yield* Effect.all(
        [
          getProbe(),
          getProbe({ authorization: basic("novaclaw", "wrong") }),
          getProbe({ authorization: basic("novaclaw", "secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(missing.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(badPassword.status).toBe(401)
      expect(badPassword.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(good.status).toBe(200)
    }),
  )

  itKitSecret.live("respects configured basic auth username", () =>
    Effect.gen(function* () {
      const [defaultUser, configuredUser] = yield* Effect.all(
        [getProbe({ authorization: basic("novaclaw", "secret") }), getProbe({ authorization: basic("kit", "secret") })],
        { concurrency: "unbounded" },
      )

      expect(defaultUser.status).toBe(401)
      expect(configuredUser.status).toBe(200)
    }),
  )

  itSecret.live("accepts auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("novaclaw", "secret"))}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("prefers auth token query credentials over basic auth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        `/probe?auth_token=${encodeURIComponent(token("novaclaw", "secret"))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", basic("novaclaw", "wrong")), HttpClient.execute)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("preserves handler errors when basic auth succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/missing").pipe(
        HttpClientRequest.setHeader("authorization", basic("novaclaw", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("preserves handler errors when auth token query succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/missing?auth_token=${encodeURIComponent(token("novaclaw", "secret"))}`)

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-base64")

      expect(response.status).toBe(401)
    }),
  )

  itV2Secret.live("returns bodyful v2 unauthorized errors", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/probe")
      const body = yield* response.json

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(body).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
    }),
  )
})
