import { armBodyIdle } from "./body-idle"

import { NodeHttpServer } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServer } from "effect/unstable/http"
import * as FileSystem from "effect/FileSystem"
import { OpenApi } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { BootProfile } from "@novaclaw/core/observability/boot-profile"
import { CrashCapture } from "@novaclaw/core/observability/crash-capture"
import { MDNS } from "./mdns"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "@novaclaw/server/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import type { CorsOptions } from "@novaclaw/server/cors"
import { lazy } from "@/util/lazy"
import { Log } from "@novaclaw/schema/log"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout.
globalThis.AI_SDK_LOG_WARNINGS = false

// ⚠️ This file is the ONE shared boot path of both entry points: `cli/cmd/serve.ts` reaches it by
// dynamic import, and the Electron sidecar reaches the same `Server.listen` through
// `virtual:novaclaw-server` → `src/node.ts`. Every mark below is therefore measured twice over —
// once per entry point — with no second harness.
BootProfile.mark("server:module-loaded")

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = CorsOptions & {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
  /**
   * What `port` MEANS, which decides what a collision does.
   *
   * `"required"` (default) — a person or a config chose this port, perhaps because a firewall rule,
   * a proxy or a bookmark depends on it. Moving silently would be answering a different question
   * than the one asked, so a collision REPORTS, by name.
   *
   * `"preferred"` — the caller only needs *a* port and picked one for us (the desktop probes a free
   * ephemeral port, closes the probe, then spawns the sidecar to bind it). That gap is a real race:
   * anything on the machine can take the port in between, and with no fallback the sidecar dies and
   * the user gets "could not start the local server" for a port they never chose and cannot see.
   */
  portIntent?: "required" | "preferred"
  /**
   * The memo map the listener's service graph is built in.
   *
   * 🔴 Pass the process's SHARED map (`@novaclaw/core/effect/memo-map`) wherever an app graph is
   * already alive in this process — the CLI's `serve` and `web`, which run under `AppRuntime`.
   * Without it the listener built a second complete instance graph beside `AppLayer`'s: two
   * `Database.Service`s over the live file (which falsified the single-connection argument behind
   * the `PATCH /config` transaction), a second MCP child manager, a second event bus whose bridge saw
   * nothing the server published.
   *
   * ⚠️ Not shared by DEFAULT, and that was measured: sharing unconditionally (2026-09-03) turned the
   * server test unit red with 401s and a missing CORS header. The route layers are module constants,
   * so in a process that listens more than once — every test file, and `web`'s relisten — the shared
   * map hands the second listener the FIRST listener's memoized auth config and CORS options, and
   * the per-listener `ConfigProvider` installed below never gets to answer. The desktop sidecar
   * constructs no `AppRuntime` and builds one graph either way; it omits this and keeps its own.
   */
  memoMap?: Layer.MemoMap
}
type ListenerState = {
  scope: Scope.Scope
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  http: ListenerServer
  websockets: WebSocketTracker.Interface
}
type EffectListener = Omit<Listener, "stop"> & {
  stop: (close?: boolean) => Effect.Effect<void>
}

interface ListenerServer {
  readonly closeAll: Effect.Effect<void>
}

class ListenerServerService extends Context.Service<ListenerServerService, ListenerServer>()(
  "@novaclaw/ListenerServer",
) {}

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export let url: URL | undefined

export async function listen(opts: ListenOptions): Promise<Listener> {
  // The crash-capture seam installs HERE for the same reason `BootProfile` marks here: this is the
  // ONE shared spine of both real server boots (`cli/cmd/serve.ts` and the Electron sidecar, per the
  // note at the top of this file), so one call site covers both with no second harness. It is
  // idempotent — `web.ts` and a relisten call `listen` again in the same process, and a second
  // install is an explicit no-op — and it refuses to install at all under `NODE_ENV=test`, which
  // matters because four test files call `Server.listen` and would otherwise get a crash reporter
  // that reports the suite's own deliberate failures. Synchronous, total, and cannot fail the boot.
  CrashCapture.install({ plane: "server" })
  const listener = await Effect.runPromise(listenEffect(opts))
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close?: boolean) => Effect.runPromiseExit(listener.stop(close)).then(() => undefined),
  }
}

const listenEffect: (opts: ListenOptions) => Effect.Effect<EffectListener, unknown> = Effect.fn("Server.listen")(
  function* (opts: ListenOptions) {
    BootProfile.mark("server:listen-start")
    const state = yield* startWithPortFallback(opts)
    const address = yield* tcpAddress(state)
    BootProfile.mark("server:tcp-address")
    const listenerUrl = makeURL(opts.hostname, address.port)
    const unpublishMdns = yield* setupMdns(opts, address.port, state.scope)
    BootProfile.mark("server:mdns")
    url = listenerUrl
    BootProfile.mark("server:listening")
    // Observation only — `report` prints nothing unless NOVACLAW_BOOT_PROFILE is set, and returns the
    // timeline either way so a caller can assert on its STRUCTURE. The entry point is derived from
    // what was observed (`cli:*` marks exist or they do not), never from a flag someone must set.
    const segment = BootProfile.entryPoint()
    BootProfile.report(segment === "serve" ? "novaclaw serve" : "electron sidecar", BootProfile.PHASES[segment])

    return {
      hostname: opts.hostname,
      port: address.port,
      url: listenerUrl,
      stop: yield* makeStop(state, unpublishMdns, listenerUrl),
    }
  },
)

function listenerLayer(opts: ListenOptions, port: number) {
  // The two taps split the single biggest phase of the boot into its two honest halves: binding the
  // TCP socket (`serverLayer` → `NodeHttpServer.layer`) and building the whole instance service graph
  // behind the routes (`createRoutes` — Database + migration, every config store, MCP, skills, the
  // messenger drivers…). `provideMerge` builds its argument FIRST, so the bind precedes the graph:
  // the port is listening while the services are still coming up, which is a fact about this boot
  // that no total could have told us. Neither tap changes what is built or in what order.
  return HttpRouter.serve(
    Layer.tap(HttpApiApp.createRoutes(opts), () => Effect.sync(() => BootProfile.mark("server:services-built"))),
    {
      middleware: disposeMiddleware,
      disableLogger: true,
      disableListenLog: true,
    },
  ).pipe(
    Layer.provideMerge(WebSocketTracker.layer),
    Layer.provideMerge(
      Layer.tap(serverLayer({ port, hostname: opts.hostname }), () =>
        Effect.sync(() => BootProfile.mark("server:http-bound")),
      ),
    ),
    // Install a fresh `ConfigProvider` per listener so `Config.string(...)`
    // reads reflect the current `process.env`. Effect's default
    // `ConfigProvider` snapshots `process.env` on first read and caches the
    // result on a module-singleton Reference; without overriding it here,
    // every later `Server.listen()` keeps observing that initial snapshot.
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

class PortUnavailableError extends Error {
  constructor(
    readonly port: number,
    cause: unknown,
  ) {
    // ⚠️ Deliberately NOT "pass --port 0". This message reaches the DESKTOP too, where the port was
    // auto-probed and the user never chose it, never typed a command, and cannot act on CLI advice.
    // It names the fact and the general remedy; the CLI adds its own flag hint at its own layer.
    super(`Port ${port} is already in use, so NovaClaw could not start there.`, { cause })
    this.name = "PortUnavailableError"
  }
}

function startWithPortFallback(opts: ListenOptions) {
  // `0` has always meant "you choose": prefer 4096 so the usual URL keeps working, else anything.
  if (opts.port === 0) return startListener(opts, 4096).pipe(Effect.catch(() => startListener(opts, 0)))

  // A port the caller only PREFERS falls back rather than killing the boot. This is the desktop's
  // case and the failure is a race it cannot win: it probes a free port, closes the probe, and the
  // sidecar binds a moment later. Losing that race used to end the boot outright.
  if (opts.portIntent === "preferred")
    return startListener(opts, opts.port).pipe(Effect.catch(() => startListener(opts, 0)))

  // A REQUIRED port reports instead of moving. Silently binding elsewhere would leave the user's
  // firewall rule, proxy or bookmark pointing at nothing, with nothing said -- and an unbound
  // expectation is worse than a refusal that names the port.
  return startListener(opts, opts.port).pipe(
    Effect.catch((cause) => Effect.fail(new PortUnavailableError(opts.port, cause))),
  )
}

function startListener(opts: ListenOptions, port: number) {
  const scope = Scope.makeUnsafe()
  // See `ListenOptions.memoMap` for why the shared map is a CHOICE the caller makes, not a default.
  return Layer.buildWithMemoMap(listenerLayer(opts, port), opts.memoMap ?? Layer.makeMemoMapUnsafe(), scope).pipe(
    Effect.provide(HttpApiApp.context),
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    Effect.map(
      (ctx): ListenerState => ({
        scope,
        server: Context.get(ctx, HttpServer.HttpServer),
        http: Context.get(ctx, ListenerServerService),
        websockets: Context.get(ctx, WebSocketTracker.Service),
      }),
    ),
  )
}

function tcpAddress(state: ListenerState) {
  return Effect.gen(function* () {
    if (state.server.address._tag === "TcpAddress") return state.server.address
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
    return yield* Effect.die(new Error(`Unexpected HttpServer address tag: ${state.server.address._tag}`))
  })
}

function makeURL(hostname: string, port: number) {
  const result = new URL("http://localhost")
  result.hostname = hostname
  result.port = String(port)
  return result
}

function setupMdns(opts: ListenOptions, port: number, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const publish =
      opts.mdns && port && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    if (publish) {
      const unpublish = yield* Effect.cached(Effect.sync(() => MDNS.unpublish()))
      // R7: advertise the instance's stable identity (+ version) in the TXT record so a
      // discovering client can dedup the same instance behind different addresses. Best-effort:
      // an identity-store failure must never block the listener coming up.
      const txt = yield* InstanceIdentityStore.Service.pipe(
        Effect.flatMap((identity) => identity.get()),
        Effect.provide(InstanceIdentityStore.defaultLayer),
        Effect.map((id) => ({ id, v: InstallationVersion })),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      yield* Effect.sync(() => MDNS.publish(port, opts.mdnsDomain, txt))
      yield* Scope.addFinalizer(scope, unpublish)
      return unpublish
    }
    if (opts.mdns) {
      yield* Log.event("server.mdns.publish.skipped", {})
    }
    return Effect.void
  })
}

function makeStop(state: ListenerState, unpublishMdns: Effect.Effect<void>, listenerUrl: URL) {
  return Effect.gen(function* () {
    const forceCloseOnce = yield* Effect.cached(forceClose(state).pipe(Effect.ignore))
    const closeScopeOnce = yield* Effect.cached(
      Scope.close(state.scope, Exit.void).pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            if (url === listenerUrl) url = undefined
          }),
        ),
      ),
    )

    return (close?: boolean) =>
      Effect.gen(function* () {
        yield* unpublishMdns
        if (close) yield* forceCloseOnce
        yield* closeScopeOnce
      })
  })
}

function forceClose(state: ListenerState) {
  return Effect.all([state.http.closeAll, state.websockets.closeAll], { concurrency: "unbounded", discard: true })
}

function serverLayer(opts: { port: number; hostname: string }) {
  const server = createServer()
  // SSE event streams are legitimately INFINITE responses: Node's default requestTimeout
  // (300s, whole-request clock) reaped them — the "connection lost — reconnecting…" blips
  // minutes apart during healthy turns (issues.md P3). 0 disables the whole-response clock;
  // headersTimeout (60s default) still guards the header phase against slow-loris, which is
  // the vector that matters on a local-first server.
  server.requestTimeout = 0
  server.keepAliveTimeout = 65_000
  /**
   * 🔴 NC-SEC-005: the byte half is guarded and the header phase is guarded; the BODY read had no
   * clock at all, so a client could send headers and dribble bytes forever. `armBodyIdle` carries the
   * reasoning and the boundaries — idle rather than total, so SSE is untouched.
   */
  const bodyIdleMs = Number(process.env.NOVACLAW_BODY_IDLE_MS ?? 30_000)
  server.on("request", (req, res) => void armBodyIdle(req, res, bodyIdleMs))
  const serverRef = { closeStarted: false, forceStop: false }
  const close = server.close.bind(server)
  // Keep shutdown owned by NodeHttpServer, but honor listener.stop(true) by
  // force-closing active HTTP sockets when its finalizer calls server.close().
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    serverRef.closeStarted = true
    const result = close(callback)
    if (serverRef.forceStop) server.closeAllConnections()
    return result
  }) as typeof server.close

  return Layer.mergeAll(
    /**
     * 🔴 A CEILING ON EVERY REQUEST BODY THIS SERVER READS. Effect's `MaxBodySize` defaults to
     * `undefined` — no limit — and a repo-wide grep found ZERO first-party uses before this line, so
     * every authenticated route buffered whatever a client chose to send.
     *
     * ⚠️ Provided at the SERVER rather than as group middleware, and that is the point. The peer
     * group already refuses on a declared `content-length` (`middleware/peer-door.ts`), but a
     * declared length is a claim: a chunked request, or one that simply omits the header, is read
     * hopefully by anything that only inspects headers. `MaxBodySize` is enforced by the reader
     * itself as bytes arrive, so it bounds the shapes a header check cannot see, and it covers every
     * route — including any added later, which a per-route list would not.
     *
     * The number is a CEILING, not a budget: it is deliberately far above every legitimate app-API
     * payload (the largest bound anywhere in the product is the messenger's 50 MB attachment cap) and
     * far below what it takes to exhaust the host. It converts "unbounded" into "bounded", which is
     * the property that was missing; tightening individual routes toward their real maxima is a
     * separate, per-route change that can now be made against a floor instead of against infinity.
     */
    Layer.succeed(HttpIncomingMessage.MaxBodySize, FileSystem.MiB(64)),
    NodeHttpServer.layer(() => server, { port: opts.port, host: opts.hostname, gracefulShutdownTimeout: "1 second" }),
    Layer.succeed(ListenerServerService)(
      ListenerServerService.of({
        closeAll: Effect.sync(() => {
          serverRef.forceStop = true
          if (serverRef.closeStarted) server.closeAllConnections()
        }),
      }),
    ),
  )
}

export * as Server from "./server"
