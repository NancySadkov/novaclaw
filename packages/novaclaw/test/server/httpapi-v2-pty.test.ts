import { afterEach, describe, expect, test } from "bun:test"
import { Context, Config as EffectConfig, Effect, Layer, Queue, Schema } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { Location } from "@novaclaw/core/location"
import { Pty } from "@novaclaw/core/pty"
import { Ticket } from "@novaclaw/schema/ticket"
import { PtyPaths } from "@novaclaw/protocol/groups/pty"
import { PtyInstancePaths } from "@novaclaw/protocol/groups/pty-instance"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testPty = process.platform === "win32" ? test.skip : test

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-novaclaw-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const instancePtyRoute = (directory: string) =>
  `${PtyInstancePaths.root}?location[directory]=${encodeURIComponent(directory)}`

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const servedRoutes: Layer.Layer<never, EffectConfig.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const effectIt = testEffect(
  Layer.mergeAll(
    testStateLayer,
    Socket.layerWebSocketConstructorGlobal,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-novaclaw-directory", dir)

const serverUrl = () => HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 pty HttpApi", () => {
  test("lists human terminal shells through the canonical surface", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const response = await request("/api/pty/shells", tmp.path)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.any(String),
          name: expect.any(String),
          acceptable: expect.any(Boolean),
        }),
      ]),
    )
  })

  test("stops all PTYs idempotently through the canonical surface", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const response = await request("/api/pty", tmp.path, { method: "DELETE" })
    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Number))(await response.json()).data).toBe(0)
  })

  test("lists and stops instance PTYs idempotently without building a location", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const listed = await request(instancePtyRoute(tmp.path), tmp.path)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([])

    const stopped = await request(instancePtyRoute(tmp.path), tmp.path, { method: "DELETE" })
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toBe(0)
  })

  testPty("reconciles every active PTY for one instance without crossing directories", async () => {
    await using first = await tmpdir({ git: true, config: { formatter: false } })
    await using second = await tmpdir({ git: true, config: { formatter: false } })
    const create = (directory: string, title: string) =>
      request("/api/pty", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 30"], title }),
      })

    const [firstCreated, secondCreated] = await Promise.all([
      create(first.path, "first"),
      create(second.path, "second"),
    ])
    expect(firstCreated.status).toBe(200)
    expect(secondCreated.status).toBe(200)

    try {
      const listed = await request(instancePtyRoute(first.path), first.path)
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual([
        expect.objectContaining({
          location: expect.objectContaining({ directory: first.path }),
          data: expect.objectContaining({ title: "first", status: "running" }),
        }),
      ])

      const stopped = await request(instancePtyRoute(first.path), first.path, { method: "DELETE" })
      expect(stopped.status).toBe(200)
      expect(await stopped.json()).toBe(1)

      const [firstAfter, secondAfter] = await Promise.all([
        request("/api/pty", first.path),
        request("/api/pty", second.path),
      ])
      expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(await firstAfter.json()).data).toEqual(
        [],
      )
      expect(
        Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(await secondAfter.json()).data,
      ).toHaveLength(1)
    } finally {
      await request("/api/pty", first.path, { method: "DELETE" })
      await request("/api/pty", second.path, { method: "DELETE" })
    }
  })

  testPty("serves location-wrapped PTY routes and retains exited sessions", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })

    const empty = await request("/api/pty", tmp.path)
    expect(empty.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(await empty.json()).data).toEqual([])

    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "exit 4"], title: "v2" }),
    })
    expect(created.status).toBe(200)
    const body = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json())
    expect(String(body.location.directory)).toBe(tmp.path)
    expect(body.data.title).toBe("v2")

    // The canonical surface keeps exited sessions observable with their exit code.
    const deadline = Date.now() + 5_000
    let info: { status: string; exitCode?: number } | undefined
    while (Date.now() < deadline) {
      const found = await request(`/api/pty/${body.data.id}`, tmp.path)
      expect(found.status).toBe(200)
      info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await found.json()).data
      if (info.status === "exited") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(info).toMatchObject({ status: "exited", exitCode: 4 })

    const removed = await request(`/api/pty/${body.data.id}`, tmp.path, { method: "DELETE" })
    expect(removed.status).toBe(204)

    const missing = await request(`/api/pty/${body.data.id}`, tmp.path)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ _tag: "PtyNotFoundError", ptyID: body.data.id })
  })

  testPty("distinguishes an idle shell from a running foreground command", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const create = (args: string[]) =>
      request("/api/pty", tmp.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/usr/bin/env", args }),
      })

    const idleCreated = await create(["sh"])
    expect(idleCreated.status).toBe(200)
    const idle = Schema.decodeUnknownSync(Location.response(Pty.Info))(await idleCreated.json()).data
    const idleActivity = await request(PtyPaths.activity.replace(":ptyID", idle.id), tmp.path)
    expect(idleActivity.status).toBe(200)
    expect(await idleActivity.json()).toMatchObject({ data: { state: "idle", descendants: 0 } })

    const busyCreated = await create(["sh", "-c", "sleep 30"])
    expect(busyCreated.status).toBe(200)
    const busy = Schema.decodeUnknownSync(Location.response(Pty.Info))(await busyCreated.json()).data
    const deadline = Date.now() + 5_000
    let activityState: string | undefined
    let descendantCount: number | undefined
    while (Date.now() < deadline) {
      const response = await request(PtyPaths.activity.replace(":ptyID", busy.id), tmp.path)
      expect(response.status).toBe(200)
      const activity = Schema.decodeUnknownSync(Location.response(Pty.Activity))(await response.json()).data
      activityState = activity.state
      descendantCount = activity.descendants
      if (activityState === "foreground") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect({ state: activityState, descendants: descendantCount }).toEqual({ state: "foreground", descendants: 1 })

    await request("/api/pty", tmp.path, { method: "DELETE" })
  })

  testPty("rejects connect tokens without the CSRF header and connects with a valid ticket", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 5"] }),
    })
    expect(created.status).toBe(200)
    const info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json()).data

    try {
      const forbidden = await request(`/api/pty/${info.id}/connect-token`, tmp.path, { method: "POST" })
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toMatchObject({ _tag: "ForbiddenError" })

      const token = await request(`/api/pty/${info.id}/connect-token`, tmp.path, {
        method: "POST",
        headers: { "x-novaclaw-ticket": "1" },
      })
      expect(token.status).toBe(200)
      const ticket = Schema.decodeUnknownSync(Location.response(Ticket.AccessToken))(await token.json()).data.ticket
      expect(ticket).toBeTruthy()

      const invalid = await request(`/api/pty/${info.id}/connect?ticket=not-a-ticket`, tmp.path)
      expect(invalid.status).toBe(403)
    } finally {
      await request(`/api/pty/${info.id}`, tmp.path, { method: "DELETE" })
    }
  })
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "serves PTY websocket output and input through the canonical route",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { formatter: false } })
        const created = yield* HttpClientRequest.post("/api/pty").pipe(
          directoryHeader(dir),
          HttpClientRequest.bodyJson({ command: "/bin/cat", title: "v2-websocket" }),
          Effect.flatMap(HttpClient.execute),
        )
        expect(created.status).toBe(200)
        const body = yield* Schema.decodeUnknownEffect(Location.response(Pty.Info))(yield* created.json)
        const info = body.data

        const socket = yield* Socket.makeWebSocket(
          `${(yield* serverUrl()).replace(/^http/, "ws")}/api/pty/${info.id}/connect?cursor=-1&location[directory]=${encodeURIComponent(dir)}`,
          { closeCodeIsError: () => false },
        )
        const messages = yield* Queue.unbounded<string>()
        yield* socket
          .runRaw((message) =>
            Queue.offer(messages, typeof message === "string" ? message : new TextDecoder().decode(message)),
          )
          .pipe(Effect.catch(() => Effect.void))
          .pipe(Effect.forkScoped)
        const write = yield* socket.writer

        const takeUntil = (expected: string, seen = ""): Effect.Effect<string, unknown> =>
          Effect.gen(function* () {
            const next = seen + (yield* Queue.take(messages).pipe(Effect.timeout("5 seconds")))
            if (next.includes(expected)) return next
            return yield* takeUntil(expected, next)
          })

        yield* write("ping-v2\n")
        expect(yield* takeUntil("ping-v2")).toContain("ping-v2")
        yield* write(new Socket.CloseEvent(1000, "done")).pipe(Effect.catch(() => Effect.void))

        const removed = yield* HttpClientRequest.delete(`/api/pty/${info.id}`).pipe(
          directoryHeader(dir),
          HttpClient.execute,
        )
        expect(removed.status).toBe(204)
      }),
  )
})
