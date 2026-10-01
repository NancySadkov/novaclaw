import type { Event } from "@novaclaw/sdk/v2/client"
import { createSimpleContext } from "@novaclaw/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { type Accessor, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"
import { streamHeartbeatMs, streamRetryDelayMs, STREAM_HEARTBEAT_MS } from "@/utils/reconnect-schedule"
import { useSupervisorPhase } from "@/hooks/use-supervisor-phase"
import { runReconnectingStream, waitForStreamRetry } from "./reconnect-stream"
import { enqueueEvent, EventBacklogOverflowError } from "./global-sync/event-backlog"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
type QueuedServerEvent = { directory: string; payload: Event }

/** Dependability P2: the per-server SSE stream status the calm reconnect surfaces read. There is
 *  deliberately no "offline" tier here — the SSE client retries until it succeeds. The numbered
 *  attempt is exposed separately, while the banner still escalates long-outage copy by wall-clock. */
export type ServerStreamStatus = "idle" | "connecting" | "connected" | "reconnecting"

type ReconnectRecovery = (signal?: AbortSignal) => Promise<void>

/**
 * The connection is not usable until every registered projection has caught up with its source.
 * Registration is synchronous: server-sync is constructed before the stream starts, so the first
 * `server.connected` cannot race past a late recovery subscriber.
 */
export function createReconnectRecoveryBarrier() {
  const recoveries = new Set<ReconnectRecovery>()
  return {
    register(recovery: ReconnectRecovery) {
      recoveries.add(recovery)
      return () => recoveries.delete(recovery)
    },
    async run(signal?: AbortSignal) {
      // Enter every recovery even if an implementation throws before returning its promise.
      const results = await Promise.allSettled(
        [...recoveries].map((recovery) => Promise.resolve().then(() => recovery(signal))),
      )
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length)
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "reconnect recovery failed",
        )
    },
  }
}

// S7: the V1 `message.part.updated`/`message.part.delta` coalescing retired with the translated
// vocabulary — the stream carries raw `session.next.*` events now, batched per frame by the
// queue/flush below. If delta churn ever matters, coalesce consecutive
// `session.next.text.delta`/`reasoning.delta` here in the NATIVE vocab.

export function resumeStreamAfterPageShow(event: PageTransitionEvent, start: () => unknown) {
  if (!event.persisted) return
  start()
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope) {
  const platform = usePlatform()
  const { phase: supervisorPhase } = useSupervisorPhase()
  const abort = new AbortController()

  /**
   * 🔴 THE START IS NOT AN OUTAGE, AND THE SHELL IS THE ONLY WITNESS THAT PROVES IT.
   *
   * Measured 2026-09-28 across nine real boots of the packaged app, the delay between the supervisor
   * reporting the server healthy and the client actually connecting was bimodal: five boots at
   * 0.2–1.2 s, four at 27.7–29.9 s. On the slow boots the server was provably answering — live
   * CORS preflight returned `204` with `Access-Control-Allow-Origin: nc://renderer` — and its own log
   * recorded no client for 35 s. The client was asleep on a backoff it had earned against a port
   * that was not bound yet, and it stayed asleep through the moment the server came up.
   *
   * So two things travel from the shell to the ladder, and only these two:
   *
   *   - `starting` selects a short poll instead of the outage schedule, because sparing a server that
   *     is down is worth nothing while the shell is deliberately bringing this one up;
   *   - the `starting` → `running` edge fires `startWindow`, which abandons the sleep in progress AND
   *     discards the failure count, because every failure in it was earned against a server that did
   *     not exist. A shorter delay cannot express that — the delay has no memory and the count is the
   *     memory — which is why the loop is told rather than merely given a smaller number.
   *
   * ⚠️ **An instance that is simply down must not be affected**, and cannot be: no start ever
   * *begins* without passing through `starting`, so a `running` or `gave-up` instance never opens a
   * window and the ladder keeps every bit of its restraint. A client with no supervisor reports no
   * phase and is likewise untouched.
   */
  let startWindow: AbortController | undefined
  let lastPhase: string | undefined
  createEffect(() => {
    const current = supervisorPhase()?.phase
    const previous = lastPhase
    lastPhase = current
    // ⚠️ Guarded on the TRANSITION, not on the value. `useSupervisorPhase` delivers the phase twice —
    // once from the subscription and once from the read that follows it — so an unguarded effect would
    // mint a second window for one start and strand the loop waiting on a signal nobody will ever
    // abort. A second start, and only a second start, mints a new one.
    if (current === "starting" && previous !== "starting") startWindow = new AbortController()
    if (current === "running" && previous !== "running") {
      startWindow?.abort()
      // 🔴 Abandon the ATTEMPT that was made while the instance was still coming up. Cutting only the
      // sleep leaves a half-open `open()` to run out its full idle heartbeat (15 s), so a server that
      // became healthy a moment after the attempt began is still connected ~15 s late. Measured on
      // packaged 0.1.83 (`%APPDATA%` log `20261001T223918`): supervisor healthy at 6.6 s, renderer
      // connected at 38.4 s, and the reachable server answered `/api/agent` in 0.28 s — the shape of a
      // half-open attempt crossing the `starting` → `running` edge. The abort surfaces as a normal
      // stream failure; the window we just spent makes the following wait immediate, so the retry lands
      // on the server that is now answering.
      attempt?.abort()
    }
  })

  const eventFetch = (() => {
    if (!platform.fetch || !server) return
    try {
      const url = new URL(server.http.url)
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loopback) return platform.fetch
    } catch {
      return
    }
  })()

  const eventSdk = createSdkForServer({
    signal: abort.signal,
    fetch: eventFetch,
    server: server.http,
  })
  const emitter = createGlobalEmitter<{
    [key: string]: Event
  }>()

  type Queued = QueuedServerEvent
  const FLUSH_FRAME_MS = 16
  const STREAM_YIELD_MS = 8

  let queue: Queued[] = []
  let buffer: Queued[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    queue = buffer
    buffer = events
    queue.length = 0

    last = Date.now()
    batch(() => {
      events.forEach((event) => emitter.emit(event.directory, event.payload))
    })

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  // Dependability P2: the per-server stream status the calm reconnect banner reads. "idle" =
  // never started/stopped, "connecting" = started but never yet received, "connected" = the SSE
  // stream is delivering, "reconnecting" = it dropped and retries are running (they never stop).
  const [streamStatus, setStreamStatus] = createSignal<ServerStreamStatus>("idle")
  const [reconnectAttemptNumber, setReconnectAttemptNumber] = createSignal(0)
  const reconnectRecovery = createReconnectRecoveryBarrier()

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let runAbort: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0
  const HEARTBEAT_TIMEOUT_MS = STREAM_HEARTBEAT_MS
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  const resetHeartbeat = (timeoutMs: number = HEARTBEAT_TIMEOUT_MS) => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attempt?.abort()
    }, timeoutMs)
  }
  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  const start = () => {
    if (started) return run
    started = true
    // An explicit start (mount, or a pageshow resume the user is watching) is a fresh intent, not a
    // retry: probe immediately rather than inheriting the previous outage's backed-off delay.
    setReconnectAttemptNumber(0)
    setStreamStatus((s) => (s === "connected" ? s : "connecting"))
    const active = ++generation
    const lifecycle = new AbortController()
    runAbort = lifecycle
    const previous = run
    const current = (async () => {
      if (previous) await previous
      const abortListeners = new WeakMap<AbortController, () => void>()
      let yielded = Date.now()
      await runReconnectingStream({
        active: () => !abort.signal.aborted && started && generation === active,
        open: async (signal) => {
          const events = await eventSdk.global.event({
            signal,
            // This loop owns retry state and recovery. Hidden SDK retries would keep the UI
            // "connected" while disconnected, then deliver another stream without reconciliation.
            sseMaxRetryAttempts: 1,
            onSseError: (error) => {
              if (isStreamClosed(error, signal)) return
              if (streamErrorLogged) return
              streamErrorLogged = true
              console.error("[global-sdk] event stream error", {
                url: server.http.url,
                fetch: eventFetch ? "platform" : "webview",
                starting: supervisorPhase()?.phase === "starting",
                error,
              })
            },
          })
          yielded = Date.now()
          resetHeartbeat()
          return events.stream
        },
        recover: (signal) => reconnectRecovery.run(signal),
        accept: async (event) => {
          resetHeartbeat()
          streamErrorLogged = false
          if (event.payload.type !== "sync" && event.payload.type !== "server.heartbeat") {
            const directory = event.directory ?? "global"
            const payload = event.payload as Event
            try {
              enqueueEvent(queue, { directory, payload })
            } catch (error) {
              if (!(error instanceof EventBacklogOverflowError)) throw error
              queue.length = 0
              buffer.length = 0
              if (timer) clearTimeout(timer)
              timer = undefined
              throw error
            }
            schedule()
          }

          if (Date.now() - yielded < STREAM_YIELD_MS) return
          yielded = Date.now()
          await wait(0)
        },
        state: (status, displayAttempt) => {
          batch(() => {
            setReconnectAttemptNumber(displayAttempt)
            setStreamStatus(status)
          })
        },
        attemptStarted: (controller) => {
          attempt = controller
          // ⚠️ Arm the heartbeat HERE, not only inside `open()` after the SSE response resolves.
          // `runReconnectingStream` awaits `open()` with no timeout of its own, so it only regains
          // control once `open()` settles. A HALF-OPEN connection — TCP established, response headers
          // never arriving — leaves `open()` unsettled, and the `resetHeartbeat()` call inside `open()`
          // is then never reached: no timer is armed, so nothing aborts, `failed()` never logs,
          // `state("reconnecting")` is never published, and the loop parks forever with no retry.
          // Measured 2026-09-12 in log/novaclaw.log: the global event stream for run=655af8cd went
          // `disconnected` at 08:06:49.885Z and the next subscription did not arrive until
          // 11:00:37.777Z — 2h53m48s of a dead stream that never once retried or raised a banner.
          // Same shape on 09-06 (3h13m), 09-07 (6h22m), 09-09 (4h05m), 09-10 (3h27m).
          // `resetHeartbeat()` also stamps `lastEventAt`, so this replaces that assignment.
          // ⚠️ While the instance is STARTING, the attempt gets the short establishment bound
          // (`streamHeartbeatMs`), not the 15 s idle heartbeat: a half-open attempt against a
          // still-booting server must not park the loop for the full idle window. The moment the
          // response headers arrive, `open()` re-arms the normal heartbeat above.
          resetHeartbeat(streamHeartbeatMs(supervisorPhase()?.phase === "starting"))
          const onAbort = () => controller.abort()
          abortListeners.set(controller, onAbort)
          abort.signal.addEventListener("abort", onAbort)
        },
        attemptFinished: (controller) => {
          const onAbort = abortListeners.get(controller)
          if (onAbort) abort.signal.removeEventListener("abort", onAbort)
          abortListeners.delete(controller)
          if (attempt === controller) attempt = undefined
          clearHeartbeat()
        },
        failed: (error, signal) => {
          if (error instanceof EventBacklogOverflowError) return
          if (!isStreamClosed(error, signal) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              starting: supervisorPhase()?.phase === "starting",
              error,
            })
          }
        },
        wait: (ms, signal) => waitForStreamRetry(ms, signal ?? lifecycle.signal),
        delay: (failure) => streamRetryDelayMs({ attempt: failure, starting: supervisorPhase()?.phase === "starting" }),
        retryNow: () => startWindow?.signal,
      })
    })().finally(() => {
      if (run !== current) return
      run = undefined
      flush()
    })
    run = current
    return run
  }

  const stop = () => {
    started = false
    generation++
    runAbort?.abort()
    attempt?.abort()
    clearHeartbeat()
    setStreamStatus("idle") // an intentionally stopped stream (pagehide/cleanup) is not an outage
    setReconnectAttemptNumber(0)
  }

  onMount(() => {
    makeEventListener(window, "pagehide", stop)
    makeEventListener(window, "pageshow", (event) => resumeStreamAfterPageShow(event, start))
    makeEventListener(document, "visibilitychange", () => {
      if (document.visibilityState !== "visible") return
      if (!started) return
      if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
      attempt?.abort()
    })
  })

  onCleanup(() => {
    stop()
    abort.abort()
    flush()
  })

  const sdk = createSdkForServer({
    server: server.http,
    fetch: platform.fetch,
    throwOnError: true,
  })

  return {
    server,
    scope,
    url: server.http.url,
    client: sdk,
    streamStatus,
    reconnectAttempt: reconnectAttemptNumber,
    reconnectRecovery: {
      register: reconnectRecovery.register,
    },
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: platform.fetch,
        ...opts,
      })
    },
  }
}

type ServerSDKBase = ReturnType<typeof createServerSdkContextBase>
export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  // Returns an accessor so the resolved server can change reactively (e.g. a
  // /new-session draft retargeting its server) without re-instantiating the subtree.
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSDK>(() => {
      const conn = props.server?.() ?? server.current
      // Programmer invariant, not a reachable state: ConnectionGate never renders the app subtree
      // while server.current is undefined (dependability P1), so a throw here means a consumer
      // mounted outside the gate — fail loudly rather than limp with a fake SDK.
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sdk
    })
  },
})

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    scope: serverSDK.scope,
    directory,
    client,
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}
