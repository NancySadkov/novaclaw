import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { createSdkForServer } from "./server"
import { Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/** `reason: "auth"` = the server answered but rejected the credentials (401/403) — legible
 *  wrong-password feedback instead of a generic "could not connect" (R6 polish). Absent reason
 *  on an unhealthy result = unreachable/timeout/other. */
export type ServerHealth = {
  healthy: boolean
  version?: string
  reason?: "auth"
  auth?: { required: boolean; source: "stored" | "launcher" | "open" }
}

/**
 * The three answers a health probe can give, as ONE value.
 *
 * `rejected` is not a degree of `unreachable`: the instance ANSWERED and refused the credentials.
 * It is fixed with a password and never by waiting, retrying or restarting, so a surface that
 * collapses the two sends the user to repair a service that is perfectly healthy. Keeping the
 * distinction in a tagged return rather than in a `reason === "auth"` string compare at each call
 * site is what stops the next caller from re-collapsing it silently.
 */
export type ServerReachability = "ok" | "rejected" | "unreachable"

/** Total over `ServerHealth`: an absent result is an absent answer, i.e. unreachable. */
export function serverReachability(health: ServerHealth | undefined): ServerReachability {
  if (!health) return "unreachable"
  if (health.healthy) return "ok"
  return health.reason === "auth" ? "rejected" : "unreachable"
}

/** The i18n key the connection gate's headline uses. */
export type ConnectionErrorHeadline = "app.server.none" | "app.server.unreachable" | "app.server.rejected"

/** The i18n key the connection gate's subline uses. */
export type ConnectionErrorDetail =
  | "app.server.noneHint"
  | "app.server.retrying"
  | "app.server.rejectedHint"
  | "app.connection.stopped.description"

/** How often the gate re-probes while it is showing an outage. */
export const GATE_PROBE_MS = 1_000
/** How often it re-probes a REJECTION — slow enough not to hammer, fast enough to clear itself. */
export const GATE_PROBE_REJECTED_MS = 15_000

/**
 * The connection gate's whole copy decision, pure — so the combinations are assertable without a
 * DOM, and so "which sentence does a 401 get" has exactly one answer.
 *
 * The retry CADENCE is part of the same decision on purpose. This screen re-probes on a timer, and
 * a refused credential does not heal by probing: an instance that answered 401 and is asked again
 * every second is the same self-inflicted hammer as an unbounded reconnect, pointed at a server
 * that has already given us its answer. So a rejection drops the "Retrying automatically…" promise
 * and slows the probe to a human-scale interval in ONE step — the sentence and the behaviour cannot
 * drift apart. It is slowed rather than stopped because the credential may be repaired on the
 * server side, and this screen must still clear by itself when it is.
 */
export function connectionErrorCopy(input: {
  readonly hasServer: boolean
  readonly reachability: ServerReachability
  readonly supervisorGaveUp: boolean
}): { headline: ConnectionErrorHeadline; detail: ConnectionErrorDetail; probeEveryMs: number } {
  if (!input.hasServer)
    return { headline: "app.server.none", detail: "app.server.noneHint", probeEveryMs: GATE_PROBE_MS }
  if (input.reachability === "rejected")
    return {
      headline: "app.server.rejected",
      detail: "app.server.rejectedHint",
      probeEveryMs: GATE_PROBE_REJECTED_MS,
    }
  if (input.supervisorGaveUp)
    return {
      headline: "app.server.unreachable",
      detail: "app.connection.stopped.description",
      probeEveryMs: GATE_PROBE_MS,
    }
  return { headline: "app.server.unreachable", detail: "app.server.retrying", probeEveryMs: GATE_PROBE_MS }
}

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000
const defaultRetryCount = 2
const defaultRetryDelayMs = 100
const cacheMs = 750
const healthCache = new Map<
  string,
  { at: number; done: boolean; fetch: typeof globalThis.fetch; promise: Promise<ServerHealth> }
>()

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.username ?? ""}\n${server.password ?? ""}`
}

function timeoutSignal(timeoutMs: number) {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (timeout) {
    try {
      return {
        signal: timeout.call(AbortSignal, timeoutMs),
        clear: undefined as (() => void) | undefined,
      }
    } catch {}
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs
  const next = (count: number, error: unknown) => {
    if (count >= retryCount || !retryable(error, signal)) return Promise.resolve({ healthy: false } as const)
    return wait(retryDelayMs * (count + 1), signal)
      .then(() => attempt(count + 1))
      .catch(() => ({ healthy: false }))
  }
  const attempt = (count: number): Promise<ServerHealth> =>
    createSdkForServer({
      server,
      fetch,
      signal,
    })
      .global.health()
      .then((x) => {
        if (x.error) {
          // A 401/403 is an ANSWER, not an outage: the server is up and the credentials are
          // wrong. Never retried (it won't heal), and reported distinctly so forms can say
          // "wrong username or password" instead of "could not connect".
          const status = (x as { response?: Response }).response?.status
          if (status === 401 || status === 403) return { healthy: false, reason: "auth" } as const
          return next(count, x.error)
        }
        const data = x.data as
          | {
              healthy?: boolean
              version?: string
              auth?: { required: boolean; source: "stored" | "launcher" | "open" }
            }
          | undefined
        return {
          healthy: data?.healthy === true,
          version: data?.version,
          ...(data?.auth ? { auth: data.auth } : {}),
        }
      })
      .catch((error) => next(count, error))
  return attempt(0).finally(() => timeout?.clear?.())
}

const pollMs = 10_000

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase) => {
    const key = cacheKey(http)
    const hit = healthCache.get(key)
    const now = Date.now()
    if (hit && hit.fetch === fetcher && (!hit.done || now - hit.at < cacheMs)) return hit.promise
    const promise = checkServerHealth(http, fetcher).finally(() => {
      const next = healthCache.get(key)
      if (!next || next.promise !== promise) return
      next.done = true
      next.at = Date.now()
    })
    healthCache.set(key, { at: now, done: false, fetch: fetcher, promise })
    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          const key = ServerConnection.key(conn)
          const result = await checkServerHealth(conn.http)
          results[key] = result
          if (!dead) setStatus(key, result)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}
