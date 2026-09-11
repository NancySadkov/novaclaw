import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@novaclaw/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { Server } from "../../src/server/server"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      NOVACLAW_SERVER_PASSWORD: Flag.NOVACLAW_SERVER_PASSWORD,
    }
    // 🔴 One line, and it is the whole credential for this file: `Flag.NOVACLAW_SERVER_PASSWORD` is an
    // accessor onto the launch-credential holder, so this sets what the auth layer reads. It used to be
    // a module-load snapshot of the environment, which is why a second `ConfigProvider` injection sat
    // further down — that pair is gone, and a file that sets its credential in two places is the shape
    // that let the old one drift.
    Flag.NOVACLAW_SERVER_PASSWORD = "secret"
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.NOVACLAW_SERVER_PASSWORD = original.NOVACLAW_SERVER_PASSWORD
        await resetDatabase()
      }),
    )
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

describe("HttpApi CORS", () => {
  it.live("allows browser preflight requests without credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.options(InstancePaths.path).pipe(
        HttpClientRequest.setHeaders({
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        }),
        HttpClient.execute,
      )

      expect(response.status).toBe(204)
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000")
      expect(response.headers["access-control-allow-headers"]).toBe("authorization")
    }),
  )

  it.live("adds CORS headers to unauthorized responses", () =>
    Effect.gen(function* () {
      const handler = HttpRouter.toWebHandler(HttpApiApp.createRoutes(), {
        disableLogger: true,
      }).handler
      const response = yield* Effect.promise(() =>
        handler(
          new Request(new URL("/global/config", "http://localhost"), {
            headers: { origin: "https://app.novaclaw.app" },
          }),
          HttpApiApp.context,
        ),
      )

      expect(response.status).toBe(401)
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.novaclaw.app")
    }),
  )

  it.live("uses custom CORS origins passed to the server", () =>
    Effect.gen(function* () {
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["https://custom.example"] })),
        (listener) => Effect.promise(() => listener.stop(true)),
      )

      const response = yield* Effect.promise(() =>
        fetch(new URL(InstancePaths.path, listener.url), {
          method: "OPTIONS",
          headers: {
            origin: "https://custom.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        }),
      )

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("https://custom.example")
      expect(response.headers.get("access-control-allow-headers")).toBe("authorization")

      const rejected = yield* Effect.promise(() =>
        fetch(new URL(InstancePaths.path, listener.url), {
          method: "OPTIONS",
          headers: {
            origin: "https://evil.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
          },
        }),
      )

      expect(rejected.status).toBe(204)
      expect(rejected.headers.get("access-control-allow-origin")).not.toBe("https://evil.example")
    }),
  )
})
