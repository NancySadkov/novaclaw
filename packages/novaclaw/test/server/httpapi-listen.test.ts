import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { readFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import { Flag } from "@novaclaw/core/flag/flag"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { Pty } from "@novaclaw/core/pty"
import { PtyID } from "@novaclaw/core/pty/schema"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { AbsolutePath } from "@novaclaw/core/schema"
import { ServerLocationServiceMap } from "../../src/location-service-map"
import { Server } from "../../src/server/server"
import { PtyPaths } from "@novaclaw/protocol/groups/pty"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const original = {
  NOVACLAW_SERVER_PASSWORD: Flag.NOVACLAW_SERVER_PASSWORD,
  NOVACLAW_SERVER_USERNAME: Flag.NOVACLAW_SERVER_USERNAME,
  envPassword: process.env.NOVACLAW_SERVER_PASSWORD,
  envUsername: process.env.NOVACLAW_SERVER_USERNAME,
}
const auth = { username: "novaclaw", password: "listen-secret" }
const testPty = test

// ⏱ The port-fallback test's time budget. See `deadline()` and the mechanical check at the bottom of
// the describe for why these three numbers are a single arithmetic invariant rather than three taste
// calls: BUDGET + CLEANUP_STAGES × CLEANUP_FLOOR must stay under the gate's per-test timeout, or a
// labelled stage failure is followed by cleanup that pushes the test past that timeout and bun kills
// it anonymously — which is exactly the `[15002.85ms]` signature the labels were added to replace.
const FALLBACK_BUDGET_MS = 12_000
const FALLBACK_CLEANUP_FLOOR_MS = 1_000
const FALLBACK_CLEANUP_STAGES = 2
// Read, not remembered: `script/test.ts`'s `PER_TEST_TIMEOUT_MS` is the number this budget must clear,
// and the check below re-derives it from that file rather than trusting this line.
const SUITE_PER_TEST_TIMEOUT_MS = 15_000

afterEach(async () => {
  Flag.NOVACLAW_SERVER_PASSWORD = original.NOVACLAW_SERVER_PASSWORD
  Flag.NOVACLAW_SERVER_USERNAME = original.NOVACLAW_SERVER_USERNAME
  if (original.envPassword === undefined) delete process.env.NOVACLAW_SERVER_PASSWORD
  else process.env.NOVACLAW_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.NOVACLAW_SERVER_USERNAME
  else process.env.NOVACLAW_SERVER_USERNAME = original.envUsername
  await disposeAllInstances()
  await resetDatabase()
})

async function startListener(extra: { memoMap?: Layer.MemoMap } = {}) {
  Flag.NOVACLAW_SERVER_PASSWORD = auth.password
  Flag.NOVACLAW_SERVER_USERNAME = auth.username
  process.env.NOVACLAW_SERVER_PASSWORD = auth.password
  process.env.NOVACLAW_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0, ...extra })
}

async function startNoAuthListener() {
  Flag.NOVACLAW_SERVER_PASSWORD = undefined
  Flag.NOVACLAW_SERVER_USERNAME = auth.username
  delete process.env.NOVACLAW_SERVER_PASSWORD
  process.env.NOVACLAW_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

function authorizationFor(password: string) {
  return `Basic ${btoa(`${auth.username}:${password}`)}`
}

function socketURL(listener: Awaited<ReturnType<typeof startListener>>, id: string, dir: string, ticket?: string) {
  const url = new URL(PtyPaths.connect.replace(":ptyID", id), listener.url)
  url.protocol = "ws:"
  url.searchParams.set("location[directory]", dir)
  url.searchParams.set("cursor", "-1")
  if (ticket) url.searchParams.set("ticket", ticket)
  return url
}

async function requestTicket(
  listener: Awaited<ReturnType<typeof startListener>>,
  id: string,
  dir: string,
  options?: { ticketHeader?: boolean; origin?: string },
) {
  const response = await fetch(new URL(PtyPaths.connectToken.replace(":ptyID", id), listener.url), {
    method: "POST",
    headers: {
      authorization: authorization(),
      "x-novaclaw-directory": dir,
      ...(options?.ticketHeader === false ? {} : { "x-novaclaw-ticket": "1" }),
      ...(options?.origin ? { origin: options.origin } : {}),
    },
  })

  return response
}

async function connectTicket(listener: Awaited<ReturnType<typeof startListener>>, id: string, dir: string) {
  const response = await requestTicket(listener, id, dir)
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: { ticket: string; expires_in: number } }).data
}

async function createCat(listener: Awaited<ReturnType<typeof startListener>>, dir: string) {
  const response = await fetch(new URL(PtyPaths.create, listener.url), {
    method: "POST",
    headers: {
      authorization: authorization(),
      "x-novaclaw-directory": dir,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      args:
        process.platform === "win32"
          ? [
              "-NoLogo",
              "-NoProfile",
              "-Command",
              "while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine('reply:' + $line) }",
            ]
          : ["-c", 'while IFS= read -r line; do printf "reply:%s\\n" "$line"; done'],
      title: "listen-smoke",
    }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: { id: string } }).data
}

async function openSocket(url: URL, onMessage?: (event: MessageEvent) => void) {
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"
  if (onMessage) ws.addEventListener("message", onMessage)
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true })
      ws.addEventListener("error", () => reject(new Error("websocket failed before open")), { once: true })
    }),
    5_000,
    "timed out waiting for websocket open",
  )
  return ws
}

async function expectSocketRejected(url: URL, init?: { headers?: Record<string, string> }) {
  // Bun's WebSocket accepts an init object with headers; standard DOM types don't reflect that.
  const Ctor = WebSocket as unknown as new (url: URL, init?: { headers?: Record<string, string> }) => WebSocket
  const ws = new Ctor(url, init)
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.addEventListener(
        "open",
        () => {
          ws.close(1000)
          reject(new Error("websocket opened"))
        },
        { once: true },
      )
      ws.addEventListener("error", () => resolve(), { once: true })
      ws.addEventListener("close", () => resolve(), { once: true })
    }),
    5_000,
    "timed out waiting for websocket rejection",
  )
}

function stop(listener: Awaited<ReturnType<typeof startListener>>, label: string) {
  return withTimeout(listener.stop(true), 10_000, label)
}

/**
 * ⏱ ONE deadline for a whole test, handed out stage by stage.
 *
 * Bounding each stage separately (2026-08-05) was supposed to let a failure name itself. It could not:
 * that test's four bounds summed to 28 s against a 15 s per-test timeout, so a labelled rejection was
 * followed by cleanup stages that carried the test past 15 s, and bun's anonymous kill printed first.
 * A shared deadline removes the arithmetic: a stage waits `min(its own cap, what is left)`, so the
 * label always reaches the reporter, and it carries where in the budget the stage started.
 *
 * `cleanup` runs in a `finally`, i.e. usually *after* the budget has already been spent, so it gets a
 * small floor instead of zero — enough to release a listener rather than leak it. That floor is what
 * `CLEANUP_STAGES × CLEANUP_FLOOR` accounts for in the invariant above.
 */
function deadline(totalMs: number, floorMs: number) {
  const started = Date.now()
  const spent = () => Date.now() - started
  const bound = <T>(promise: Promise<T>, capMs: number, label: string, leftMs: number) => {
    const ms = Math.min(capMs, leftMs)
    return withTimeout(promise, ms, `${label} — bounded at ${ms}ms, ${spent()}ms into a ${totalMs}ms test budget`)
  }
  return {
    spent,
    stage: <T>(promise: Promise<T>, capMs: number, label: string) =>
      bound(promise, capMs, label, Math.max(totalMs - spent(), 0)),
    cleanup: <T>(promise: Promise<T>, capMs: number, label: string) =>
      bound(promise, capMs, label, Math.max(totalMs - spent(), floorMs)),
  }
}

function waitForMessage(ws: WebSocket, predicate: (message: string) => boolean) {
  const decoder = new TextDecoder()
  let received = ""
  let onMessage: ((event: MessageEvent) => void) | undefined
  return withTimeout(
    new Promise<string>((resolve) => {
      onMessage = (event: MessageEvent) => {
        const message = typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer)
        received += message
        if (!predicate(received)) return
        resolve(received)
      }
      ws.addEventListener("message", onMessage)
    }),
    5_000,
    "timed out waiting for websocket message",
  ).finally(() => {
    if (onMessage) ws.removeEventListener("message", onMessage)
  })
}

async function openPtySocket(listener: Awaited<ReturnType<typeof startListener>>, dir: string) {
  const info = await createCat(listener, dir)
  const ticket = await connectTicket(listener, info.id, dir)
  const ws = await openSocket(socketURL(listener, info.id, dir, ticket.ticket))
  return {
    ws,
    closed: new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true })),
  }
}

describe("HttpApi Server.listen", () => {
  testPty("listener replacement detaches and replays the same live PTY from its last cursor", async () => {
    await using tmp = await tmpdir({ config: { formatter: false } })
    const shared = Layer.makeMemoMapUnsafe()
    const scope = Scope.makeUnsafe()
    const services = await Effect.runPromise(Layer.buildWithMemoMap(ServerLocationServiceMap.layer, shared, scope))
    const locations = Context.get(services, LocationServiceMap.Service)
    const local = await Effect.runPromise(
      Layer.buildWithMemoMap(
        locations.get(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })),
        shared,
        scope,
      ),
    )
    const pty = Context.get(local, Pty.Service)
    const attach = pty.attach
    let attachments = 0
    const expectedReplays: string[] = []
    const tracked = spyOn(pty, "attach").mockImplementation((id, input) =>
      attach(id, input).pipe(
        Effect.map((attachment) => {
          attachments++
          expectedReplays.push(attachment.replay)
          let detached = false
          return {
            ...attachment,
            detach: () => {
              attachment.detach()
              if (!detached) attachments--
              detached = true
            },
          }
        }),
      ),
    )
    let listener: Awaited<ReturnType<typeof startListener>> | undefined
    let ws: WebSocket | undefined
    try {
      listener = await startListener({ memoMap: shared })
      const info = await createCat(listener, tmp.path)
      let cursor = 0
      let received = ""
      let metadataFrames = 0
      let replayed = ""
      const replay = Promise.withResolvers<void>()
      const record = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
        if (data.startsWith("\0")) {
          cursor = JSON.parse(data.slice(1)).cursor
          if (++metadataFrames === 2) {
            replayed = received
            replay.resolve()
          }
        } else {
          received += data
          cursor += data.length
        }
      }
      const ticket = await connectTicket(listener, info.id, tmp.path)
      ws = await openSocket(socketURL(listener, info.id, tmp.path, ticket.ticket), record)
      const first = waitForMessage(ws, (data) => data.includes("reply:before-restart"))
      ws.send("before-restart\r")
      await first
      expect(attachments).toBe(1)
      await stop(listener, "listener replacement close")
      listener = undefined
      expect(attachments).toBe(0)
      const retainedCursor = cursor
      // Keep the instance graph alive, as the desktop does when only its listener is replaced.
      expect((await Effect.runPromise(pty.get(PtyID.make(info.id)))).status).toBe("running")
      const output = Promise.withResolvers<void>()
      let absentOutput = ""
      const observer = await Effect.runPromise(
        attach(PtyID.make(info.id), {
          cursor: -1,
          onData: (data) => {
            absentOutput += data
            if (absentOutput.includes("reply:during-restart")) output.resolve()
          },
          onEnd: () => {},
        }),
      )
      observer.activate()
      try {
        await Effect.runPromise(pty.write(PtyID.make(info.id), "during-restart\r"))
        await withTimeout(output.promise, 5_000, "PTY output while listener is absent")
      } finally {
        observer.detach()
      }
      listener = await startListener({ memoMap: shared })
      const nextTicket = await connectTicket(listener, info.id, tmp.path)
      const url = socketURL(listener, info.id, tmp.path, nextTicket.ticket)
      url.searchParams.set("cursor", String(retainedCursor))
      received = ""
      ws = await openSocket(url, record)
      await withTimeout(replay.promise, 5_000, "same PTY cursor replay")
      expect(replayed).toBe(expectedReplays[1])
      expect(received).not.toContain("before-restart")
      expect(received).toContain("during-restart")
      const fresh = waitForMessage(ws, (data) => data.includes("after-restart"))
      ws.send("after-restart\r\n")
      await fresh
      expect(received.indexOf("during-restart")).toBeLessThan(received.indexOf("after-restart"))
      await stop(listener, "restarted listener close")
      listener = undefined
      expect(attachments).toBe(0)
    } finally {
      ws?.close()
      if (listener) await stop(listener, "replay test cleanup")
      tracked.mockRestore()
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test("stored token rotates live, reports provenance, and clearing restores the launcher default", async () => {
    const listener = await startListener()
    const rotated = "rotated-listen-secret"
    const configURL = new URL("/global/config", listener.url)
    const healthURL = new URL("/global/health", listener.url)
    const patch = (password: string, credential: string) =>
      fetch(configURL, {
        method: "PATCH",
        headers: {
          authorization: authorizationFor(credential),
          "content-type": "application/json",
        },
        body: JSON.stringify({ server: { password } }),
      })

    try {
      expect((await patch(rotated, auth.password)).status).toBe(200)

      const [oldConfig, newConfig, bootstrapHealth] = await Promise.all([
        fetch(configURL, { headers: { authorization: authorization() } }),
        fetch(configURL, { headers: { authorization: authorizationFor(rotated) } }),
        fetch(healthURL, { headers: { authorization: authorization() } }),
      ])
      expect(oldConfig.status).toBe(401)
      expect(newConfig.status).toBe(200)
      expect(bootstrapHealth.status).toBe(200)
      expect((await bootstrapHealth.json()).auth).toEqual({ required: true, source: "stored" })

      expect((await patch("", rotated)).status).toBe(200)
      expect((await fetch(configURL, { headers: { authorization: authorization() } })).status).toBe(200)
      expect((await fetch(configURL, { headers: { authorization: authorizationFor(rotated) } })).status).toBe(401)
      const restored = await fetch(healthURL, { headers: { authorization: authorization() } })
      expect((await restored.json()).auth).toEqual({ required: true, source: "launcher" })
    } finally {
      await stop(listener, "token rotation listener cleanup")
    }
  })

  testPty("serves HTTP routes and upgrades PTY websocket through Server.listen", async () => {
    await using tmp = await tmpdir({ config: { formatter: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const response = await fetch(new URL(PtyPaths.shells, listener.url), {
        headers: { authorization: authorization(), "x-novaclaw-directory": tmp.path },
      })
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

      const info = await createCat(listener, tmp.path)
      const ticket = await connectTicket(listener, info.id, tmp.path)
      expect(ticket.expires_in).toBeGreaterThan(0)
      const ws = await openSocket(socketURL(listener, info.id, tmp.path, ticket.ticket))
      const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve, { once: true }))

      const message = waitForMessage(ws, (message) => message.includes("ping-listen"))
      ws.send("ping-listen\n")
      expect(await message).toContain("ping-listen")

      await stop(listener, "timed out waiting for listener.stop(true)")
      stopped = true
      const close = await withTimeout(closed, 5_000, "timed out waiting for websocket close")
      // Bun's NodeWS adapter currently normalizes 1001 to 1000; it retains the reason.
      // websocket-tracker.test.ts separately pins the requested wire event to 1001.
      expect(close.code).toBe(process.versions.bun ? 1000 : 1001)
      expect(close.reason).toBe("server closing")
      expect(ws.readyState).toBe(WebSocket.CLOSED)

      const restarted = await startListener()
      try {
        const nextInfo = await createCat(restarted, tmp.path)
        const nextTicket = await connectTicket(restarted, nextInfo.id, tmp.path)
        const nextWs = await openSocket(socketURL(restarted, nextInfo.id, tmp.path, nextTicket.ticket))
        const nextMessage = waitForMessage(nextWs, (message) => message.includes("ping-restarted"))
        nextWs.send("ping-restarted\n")
        expect(await nextMessage).toContain("ping-restarted")
        nextWs.close(1000)
      } finally {
        await stop(restarted, "timed out waiting for restarted listener.stop(true)")
      }
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up listener").catch(() => undefined)
    }
  })

  testPty("stop(true) is safe when called concurrently and repeatedly", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const socket = await openPtySocket(listener, tmp.path)

      await withTimeout(
        Promise.all([listener.stop(true), listener.stop(true)]).then(() => undefined),
        10_000,
        "timed out waiting for concurrent listener.stop(true)",
      )
      await withTimeout(socket.closed, 5_000, "timed out waiting for websocket close after concurrent stop")
      await withTimeout(listener.stop(true), 5_000, "timed out waiting for repeated listener.stop(true)")
      stopped = true
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up concurrent stop listener").catch(() => undefined)
    }
  })

  testPty("stop(true) can force a graceful stop already in progress", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const socket = await openPtySocket(listener, tmp.path)

      const graceful = listener.stop()
      const forced = listener.stop(true)
      await withTimeout(
        Promise.all([graceful, forced]).then(() => undefined),
        10_000,
        "timed out waiting for forced listener stop",
      )
      await withTimeout(socket.closed, 5_000, "timed out waiting for websocket close after forced stop")
      stopped = true
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up forced stop listener").catch(() => undefined)
    }
  })

  testPty("graceful stop waits for an overlapping forced stop", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const listener = await startListener()
    let stopped = false
    try {
      const socket = await openPtySocket(listener, tmp.path)
      const forced = listener.stop(true)
      await withTimeout(listener.stop(), 10_000, "timed out waiting for graceful stop after forced stop")
      stopped = true
      await withTimeout(forced, 5_000, "timed out waiting for overlapping forced stop")
      await withTimeout(socket.closed, 5_000, "timed out waiting for websocket close before graceful stop resolved")
    } finally {
      if (!stopped) await stop(listener, "timed out cleaning up overlapping stop listener").catch(() => undefined)
    }
  })

  /**
   * One process, ONE graph. `novaclaw serve` materialises `AppLayer` through `AppRuntime` and then
   * calls `Server.listen`. Until 2026-09-03 the listener built its routes against a FRESH
   * `Layer.makeMemoMapUnsafe()`, so the shipped process ran two complete instance graphs: two
   * `Database.Service`s over the live file (which falsified `config-store-write.ts`'s
   * single-connection argument for `PATCH /config`), a second MCP child manager, and a second event
   * bus whose `EventV2Bridge` never saw what the server published. Every other build site threads
   * the shared `memoMap`.
   *
   * Under this package's `NOVACLAW_DB=":memory:"` a database is identified by its layer BUILD, which
   * makes the defect directly observable rather than inferred: a session written behind the shared
   * `memoMap` is served by a listener that shares the map, and is a 404 to one that built its own.
   * A/B'd on the day this landed — 404 without the option, 200 with it. The option is what
   * `serve.ts` and `web.ts` pass; `serve-shares-app-graph.test.ts` pins that they do.
   */
  test("🔴 one process, one graph: a session seeded behind the shared memo map is served by Server.listen", async () => {
    // What `serve.ts` and `web.ts` pass. Every other test in this file listens in its OWN map, which
    // is also what a second `listen` in one process needs for its per-listener config to apply.
    const listener = await startListener({ memoMap })
    await using tmp = await tmpdir()
    try {
      const id = SessionSchema.ID.make("ses_listenonegraph")
      const services = await Effect.runPromise(
        Layer.buildWithMemoMap(Database.defaultLayer, memoMap, Scope.makeUnsafe()),
      )
      const { db } = Context.get(services, Database.Service)
      await Effect.runPromise(
        db
          .insert(SessionTable)
          .values({ id, slug: id, directory: tmp.path, title: id, version: "test" })
          .run()
          .pipe(Effect.orDie),
      )
      const response = await fetch(new URL(`/api/session/${id}`, listener.url), {
        headers: { authorization: authorization(), "x-novaclaw-directory": tmp.path },
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { data: { id: string } }).data.id).toBe(id)
    } finally {
      await listener.stop(true)
    }
  })

  test("stop() gracefully closes an idle listener and is repeat-safe", async () => {
    const listener = await startListener()
    await withTimeout(listener.stop(), 10_000, "timed out waiting for graceful listener.stop()")
    await withTimeout(listener.stop(), 5_000, "timed out waiting for repeated graceful listener.stop()")
    await expect(
      fetch(new URL(PtyPaths.shells, listener.url), { headers: { authorization: authorization() } }),
    ).rejects.toThrow()
  })

  test("default in-process handler does not emit Effect HTTP response logs", async () => {
    let output = ""
    // oxlint-disable-next-line typescript-eslint/unbound-method -- restored in finally after temporarily capturing stderr.
    const original = process.stderr.write
    process.stderr.write = ((chunk) => {
      output += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      // /status has no route; without an embedded web UI the catch-all answers a
      // plain 404 (the upstream remote-proxy fallback was removed — it 500ed offline).
      const response = await Server.Default().app.request("/status")
      expect(response.status).toBe(404)
    } finally {
      process.stderr.write = original
    }

    expect(output).not.toContain("Sent HTTP response")
  })

  test("port 0 prefers 4096 when free", async () => {
    // 4096 is the product's preferred port, not this test's choice — see the fallback test below for
    // why the number cannot be moved. If something else on this machine holds it there is no claim to
    // make, so this passes vacuously; the fallback test is the one that stays meaningful either way.
    if (!(await isPortFree(4096))) return
    const listener = await startListener()
    try {
      expect(listener.port).toBe(4096)
    } finally {
      await stop(listener, "timed out cleaning up port-0 prefers-4096 listener")
    }
  })

  /**
   * An EXPLICIT port used to have no fallback at all, so a collision ended the boot. That is not a
   * hypothetical: the desktop probes a free ephemeral port, closes the probe, and the sidecar binds
   * it a moment later — anything on the machine can take it in that gap, and the user gets "could
   * not start the local server" for a port they never chose and cannot see.
   *
   * The two arms differ because the intent differs, and collapsing them would be wrong in one
   * direction or the other: a port someone CHOSE must not move silently (their firewall rule or
   * bookmark would point at nothing), and a port we merely picked for ourselves must not be fatal.
   *
   * ⚠️ Uses an ephemeral port, NOT 4096 — unlike the test below, the number here is arbitrary, and
   * borrowing 4096 would couple these to the product's default for no reason.
   */
  test("a REQUIRED port that is taken reports the port by name instead of dying", async () => {
    const budget = deadline(FALLBACK_BUDGET_MS, FALLBACK_CLEANUP_FLOOR_MS)
    // `occupyPort(0)` cannot collide, so this is always our own blocker — but PortHolder is a union
    // and narrowing it here is cheaper than widening the helper for two callers.
    const probe = await occupyPort(0)
    const blocker = probe.held === "this test" ? probe.server : undefined
    if (!blocker) throw new Error("could not open an ephemeral blocker port")
    const port = (blocker.address() as net.AddressInfo).port
    try {
      let failure: unknown
      try {
        await budget.stage(
          Server.listen({ hostname: "127.0.0.1", port }),
          8_000,
          "required-port listen neither bound nor failed",
        )
      } catch (error) {
        failure = error
      }
      // A raw EADDRINUSE names nothing a user can act on; the refusal must say WHICH port and what
      // to do instead, because this message is the whole of their diagnosis.
      expect(failure, "a taken required port must refuse, not bind").toBeDefined()
      expect(String((failure as Error)?.message ?? failure)).toContain(String(port))
      // ⚠️ Must NOT hand a desktop user CLI advice: this same error surfaces in the packaged app,
      // where the port was auto-probed and no command was ever typed.
      expect(String((failure as Error)?.message ?? failure)).not.toContain("--port")
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  test("a PREFERRED port that is taken falls back instead of killing the boot", async () => {
    const budget = deadline(FALLBACK_BUDGET_MS, FALLBACK_CLEANUP_FLOOR_MS)
    const probe = await occupyPort(0)
    const blocker = probe.held === "this test" ? probe.server : undefined
    if (!blocker) throw new Error("could not open an ephemeral blocker port")
    const port = (blocker.address() as net.AddressInfo).port
    try {
      const listener = await budget.stage(
        Server.listen({ hostname: "127.0.0.1", port, portIntent: "preferred" }),
        8_000,
        "preferred-port listen did not fall back",
      )
      try {
        // THE assertion: it is listening somewhere, and somewhere is not the taken port.
        expect(listener.port).not.toBe(port)
        expect(listener.port).toBeGreaterThan(0)
      } finally {
        await budget.cleanup(listener.stop(true), 4_000, "preferred-port listener did not stop")
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  test("port 0 falls back when 4096 is taken", async () => {
    // ⚠️ 4096 IS THE SUBJECT OF THIS TEST, NOT AN ARBITRARY PORT — do not "fix" the sharing by moving
    // it. `Server.listen`'s `startWithPortFallback` (src/server/server.ts) compiles the literal in:
    // `port: 0` means *try 4096, then any free port*. Occupy any other port and the first attempt
    // succeeds, so the fallback branch is never entered and this test asserts the opposite of the
    // truth. The number is shared with `.claude/launch.json`'s webapp backend because it is the
    // product's real default, which is the whole reason the claim is worth pinning.
    //
    // What CAN be made immune is the environment, and this test now is, in three ways:
    //  1. an externally-held 4096 satisfies the precondition just as well as our own blocker, so it
    //     no longer skips out silently — a running web preview exercises the same product branch;
    //  2. the blocker destroys connections on accept. It used to have no connection handler, so the
    //     preview page's retry loop (which keeps hammering :4096 after `preview_stop` kills the
    //     server) was ACCEPTED and parked here for the whole test — the measured ~5.2 s poisoner;
    //  3. every stage draws on one shared deadline, so a stuck stage names itself instead of being
    //     buried under bun's anonymous per-test kill.
    // See  §gate hygiene: do not pin this, and do not raise the suite timeout.
    const budget = deadline(FALLBACK_BUDGET_MS, FALLBACK_CLEANUP_FLOOR_MS)
    const occupied = await budget.stage(occupyPort(4096), 5_000, "could not settle who holds 4096")
    try {
      const listener = await budget.stage(
        startListener(),
        8_000,
        `timed out starting the port-0 listener while 4096 was held by ${occupied.held}`,
      )
      try {
        // A bare `expect(listener.port).not.toBe(4096)` prints `expect(4096).not.toBe(4096)`, which
        // names no cause — and the two ways this claim can break have different repairs.
        if (listener.port === 4096) {
          throw new Error(
            occupied.held === "this test"
              ? "the port-0 listener bound 4096 while this test's own blocker still held it — Server.listen's 4096-first fallback did not fall back"
              : `4096 was held by another process when this test started (${occupied.code}) and was released before the listener bound, so the fallback branch was never entered. Nothing else on this machine may hold 4096 during the gate — the web preview's backend does (.claude/launch.json).`,
          )
        }
        expect(listener.port).toBeGreaterThan(0)
      } finally {
        await budget.cleanup(listener.stop(true), 10_000, "timed out cleaning up port-0 fallback listener")
      }
    } finally {
      if (occupied.held === "this test") {
        // `net.Server.close()` waits for every accepted connection to end. The destroy-on-accept
        // handler above means there should be none, but a socket accepted between the last destroy
        // and this call would still park the callback forever, so drop them first.
        // Cast because the ambient `net.Server` type here predates it; it exists on Node 18.2+ and the
        // optional call keeps it harmless if a runtime ever lacks it.
        const blocker = occupied.server
        ;(blocker as { closeAllConnections?: () => void }).closeAllConnections?.()
        await budget.cleanup(
          new Promise<void>((resolve) => blocker.close(() => resolve())),
          5_000,
          "timed out releasing the 4096 blocker — a connection to it never closed",
        )
      }
    }
  })

  test("the port-fallback test's stage budget cannot outlive the gate's per-test timeout", async () => {
    // Ruling 1: this invariant's violation compiles green. Raise a stage cap past the budget, add a
    // third cleanup stage, or lower the gate's timeout, and the port-fallback test silently goes back
    // to dying as an anonymous `[15002.85ms]` kill with its stage label unprinted — which is the
    // single thing that stalled that diagnosis for a week. So it is asserted, not documented.
    expect(FALLBACK_BUDGET_MS + FALLBACK_CLEANUP_STAGES * FALLBACK_CLEANUP_FLOOR_MS).toBeLessThan(
      SUITE_PER_TEST_TIMEOUT_MS,
    )

    // ...and `SUITE_PER_TEST_TIMEOUT_MS` is re-derived from the gate rather than remembered. Comments
    // are stripped first: a regex over source counts prose, and this file discusses the number it is
    // matching. Exactly one declaration must survive — zero or two means the constant moved and this
    // budget is being checked against a number that no longer sets anything.
    const source = await readFile(path.resolve(import.meta.dir, "../../../../script/test.ts"), "utf8")
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    const declarations = [...code.matchAll(/const PER_TEST_TIMEOUT_MS = ([\d_]+)/g)]
    expect(declarations).toHaveLength(1)
    expect(Number(declarations[0][1].replaceAll("_", ""))).toBe(SUITE_PER_TEST_TIMEOUT_MS)
  })

  testPty("rejects unsafe PTY ticket mint and connect requests", async () => {
    await using tmp = await tmpdir({ config: { formatter: false } })
    const listener = await startListener()
    try {
      const info = await createCat(listener, tmp.path)

      expect((await requestTicket(listener, info.id, tmp.path, { ticketHeader: false })).status).toBe(403)
      expect((await requestTicket(listener, info.id, tmp.path, { origin: "https://evil.example" })).status).toBe(403)

      // Regression for #25698: minting without a directory uses the server cwd
      // and cannot find a PTY registered in a project directory.
      const ambiguous = await fetch(new URL(PtyPaths.connectToken.replace(":ptyID", info.id), listener.url), {
        method: "POST",
        headers: { authorization: authorization(), "x-novaclaw-ticket": "1" },
      })
      expect(ambiguous.status).toBe(404)

      const directoryScoped = await fetch(
        new URL(
          `${PtyPaths.connectToken.replace(":ptyID", info.id)}?location%5Bdirectory%5D=${encodeURIComponent(tmp.path)}`,
          listener.url,
        ),
        {
          method: "POST",
          headers: { authorization: authorization(), "x-novaclaw-ticket": "1" },
        },
      )
      expect(directoryScoped.status).toBe(200)
      const mint = (await directoryScoped.json()) as { data: { ticket: string } }
      const scopedWs = await openSocket(socketURL(listener, info.id, tmp.path, mint.data.ticket))
      scopedWs.close(1000)

      await expectSocketRejected(socketURL(listener, info.id, tmp.path, "not-a-ticket"))

      const reusable = await connectTicket(listener, info.id, tmp.path)
      const ws = await openSocket(socketURL(listener, info.id, tmp.path, reusable.ticket))
      await expectSocketRejected(socketURL(listener, info.id, tmp.path, reusable.ticket))
      ws.close(1000)

      const other = await createCat(listener, tmp.path)
      const scoped = await connectTicket(listener, info.id, tmp.path)
      await expectSocketRejected(socketURL(listener, other.id, tmp.path, scoped.ticket))

      const crossOrigin = await connectTicket(listener, info.id, tmp.path)
      await expectSocketRejected(socketURL(listener, info.id, tmp.path, crossOrigin.ticket), {
        headers: { origin: "https://evil.example" },
      })
    } finally {
      await stop(listener, "timed out cleaning up rejected ticket listener").catch(() => undefined)
    }
  })

  testPty("keeps PTY websocket tickets optional when server auth is disabled", async () => {
    await using tmp = await tmpdir({ config: { formatter: false } })
    const listener = await startNoAuthListener()
    try {
      const info = await createCat(listener, tmp.path)
      const ws = await openSocket(socketURL(listener, info.id, tmp.path))
      const message = waitForMessage(ws, (message) => message.includes("ping-no-auth"))
      ws.send("ping-no-auth\n")
      expect(await message).toContain("ping-no-auth")
      ws.close(1000)
    } finally {
      await stop(listener, "timed out cleaning up no-auth listener").catch(() => undefined)
    }
  })
})

function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })
}

/**
 * Settle who holds `port`, rather than only trying to take it.
 *
 * This used to resolve `undefined` on any bind error and the caller returned early — so a machine
 * where the web preview already held 4096 turned the port-fallback claim into a vacuous pass, and the
 * one environment that most needs the claim checked was the one that stopped checking it. An
 * externally-held port satisfies the precondition exactly as well: `Server.listen` gets `EADDRINUSE`
 * from whoever holds it and takes the same fallback branch, so report the holder and let the test run.
 *
 * `EACCES` counts as held too — on Windows it is what an excluded/reserved port range answers, and the
 * product's bind fails there for the same reason ours did. Any other error is a real fault and rejects.
 *
 * ⚠️ The connection handler is load-bearing, not decoration. `net.createServer()` with no `connection`
 * listener still ACCEPTS every inbound socket and parks it in the server's connection set; the preview
 * page's retry loop against :4096 therefore accumulated sockets here for the whole test and blocked
 * `close()`. Destroying on accept makes a retry loop cost a reset apiece and hold nothing.
 */
type PortHolder = { held: "this test"; server: net.Server } | { held: "another process"; code: string }

function occupyPort(port: number) {
  return new Promise<PortHolder>((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy())
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve({ held: "another process", code: error.code })
      else reject(error)
    })
    server.listen(port, "127.0.0.1", () => resolve({ held: "this test", server }))
  })
}
