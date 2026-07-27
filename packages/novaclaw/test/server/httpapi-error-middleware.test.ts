import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { NamedError } from "@novaclaw/core/util/error"
import { describe, expect } from "bun:test"
import { ConfigError } from "@novaclaw/core/config/error"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { errorLayer } from "../../src/server/routes/instance/httpapi/middleware/error"
import { NotFoundError } from "../../src/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

function expectUnknownErrorBody(body: unknown) {
  expect(body).toMatchObject({ name: "UnknownError" })
  const data = (body as { data?: { ref?: unknown; message?: unknown } }).data
  expect(data?.ref).toMatch(/^err_[0-9a-f-]{8}$/)
  // The body is asserted against the SHARED builder rather than a copied literal, so the wording can
  // be improved in one place without this test pinning it back.
  expect(data?.message).toBe(NamedError.internalMessage(data?.ref as string))
  // What the user reads must not send them somewhere they cannot go. The old text said "check server
  // logs", which a normal person does not have — and which was empty anyway in the packaged app.
  expect(String(data?.message)).not.toContain("server logs")
  expect(String(data?.message)).toContain(String(data?.ref))
}

describe("HttpApi error middleware", () => {
  it.live("returns a safe body for unknown 500 defects", () =>
    Effect.gen(function* () {
      yield* HttpRouter.add("GET", "/boom", Effect.die(new Error("secret stack marker"))).pipe(
        Layer.provide(errorLayer),
        HttpRouter.serve,
        Layer.build,
      )

      const response = yield* HttpClientRequest.get("/boom").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(500)
      expectUnknownErrorBody(body)
      expect(JSON.stringify(body)).not.toContain("secret stack marker")
    }),
  )

  it.live("returns a safe body for named defects", () =>
    Effect.gen(function* () {
      yield* HttpRouter.add(
        "GET",
        "/named",
        Effect.die(new NamedError.Unknown({ message: "secret named marker" })),
      ).pipe(Layer.provide(errorLayer), HttpRouter.serve, Layer.build)

      const response = yield* HttpClientRequest.get("/named").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(500)
      expectUnknownErrorBody(body)
      expect(JSON.stringify(body)).not.toContain("secret named marker")
    }),
  )

  it.live("returns invalid config defects as structured client errors", () =>
    Effect.gen(function* () {
      const configError = new ConfigError.InvalidError({
        path: "/tmp/novaclaw.json",
        issues: [{ message: "Expected object", path: ["provider", "anthropic", "options"] }],
      })

      yield* HttpRouter.add("GET", "/config-error", Effect.die(configError)).pipe(
        Layer.provide(errorLayer),
        HttpRouter.serve,
        Layer.build,
      )

      const response = yield* HttpClientRequest.get("/config-error").pipe(HttpClient.execute)
      const body = yield* response.json
      const serialized = JSON.stringify(body)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({
        name: "ConfigInvalidError",
        data: {
          path: "/tmp/novaclaw.json",
          issues: [{ message: "Expected object", path: ["provider", "anthropic", "options"] }],
        },
      })
      expect(serialized).toContain("/tmp/novaclaw.json")
      expect(serialized).toContain("anthropic")
    }),
  )

  it.live("does not map storage not-found defects to 404", () =>
    Effect.gen(function* () {
      yield* HttpRouter.add(
        "GET",
        "/missing",
        Effect.die(new NotFoundError({ message: "Resource not found: secret" })),
      ).pipe(Layer.provide(errorLayer), HttpRouter.serve, Layer.build)

      const response = yield* HttpClientRequest.get("/missing").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(500)
      expectUnknownErrorBody(body)
    }),
  )
})
