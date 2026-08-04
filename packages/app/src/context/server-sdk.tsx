import type { Event } from "@novaclaw/sdk/v2/client"
import { createSimpleContext } from "@novaclaw/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { type Accessor, batch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
type QueuedServerEvent = { directory: string; payload: Event }

/** Dependability P2: the per-server SSE stream status the calm reconnect banner reads. There is
 *  deliberately no "offline" tier here — the SSE client retries internally and the outer loop only
 *  re-enters on the 15s heartbeat, so failure COUNTS don't measure outage duration; the banner
 *  escalates its own copy by wall-clock instead. */
export type ServerStreamStatus = "idle" | "connecting" | "connected" | "reconnecting"

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
  const abort = new AbortController()

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
  const RECONNECT_DELAY_MS = 250

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

  let streamErrorLogged = false
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0
  const HEARTBEAT_TIMEOUT_MS = 15_000
  let lastEventAt = Date.now()
  let heartbeat: ReturnType<typeof setTimeout> | undefined
  const resetHeartbeat = () => {
    lastEventAt = Date.now()
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(() => {
      attempt?.abort()
    }, HEARTBEAT_TIMEOUT_MS)
  }
  const clearHeartbeat = () => {
    if (!heartbeat) return
    clearTimeout(heartbeat)
    heartbeat = undefined
  }

  const start = () => {
    if (started) return run
    started = true
    setStreamStatus((s) => (s === "connected" ? s : "connecting"))
    const active = ++generation
    const previous = run
    const current = (async () => {
      if (previous) await previous
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started && generation === active) {
        attempt = new AbortController()
        lastEventAt = Date.now()
        const onAbort = () => {
          attempt?.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        try {
          const events = await eventSdk.global.event({
            signal: attempt.signal,
            onSseError: (error) => {
              if (isStreamClosed(error, attempt?.signal)) return
              if (streamErrorLogged) return
              streamErrorLogged = true
              console.error("[global-sdk] event stream error", {
                url: server.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            },
          })
          let yielded = Date.now()
          resetHeartbeat()
          // P2: "connected" flips on the FIRST RECEIVED ITEM, not on `.event()` resolving — the SDK
          // returns its stream object lazily WITHOUT having connected, so a dead server still
          // resolves the call and would flap connected↔reconnecting every retry (measured live:
          // the flap kept the banner's 2s debounce from ever firing). Receiving data is the only
          // truthful definition; the server streams sync/keepalive items well inside the 15s
          // heartbeat, so a healthy connection flips within moments.
          let receivedAny = false
          for await (const event of events.stream) {
            if (!receivedAny) {
              receivedAny = true
              setStreamStatus("connected")
            }
            resetHeartbeat()
            streamErrorLogged = false
            if (event.payload.type !== "sync") {
              const directory = event.directory ?? "global"
              const payload = event.payload as Event
              queue.push({ directory, payload })
              schedule()
            }

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
        } catch (error) {
          if (!isStreamClosed(error, attempt?.signal) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = undefined
          clearHeartbeat()
        }

        if (abort.signal.aborted || !started || generation !== active) return
        // P2: the stream dropped (or never delivered) and retries continue.
        setStreamStatus("reconnecting")
        await wait(RECONNECT_DELAY_MS)
      }
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
    attempt?.abort()
    clearHeartbeat()
    setStreamStatus("idle") // an intentionally stopped stream (pagehide/cleanup) is not an outage
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
