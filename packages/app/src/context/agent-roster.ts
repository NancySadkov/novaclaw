import { batch, createSignal, onCleanup, untrack } from "solid-js"
import type { Event } from "@novaclaw/sdk/v2/client"
import type { AgentLike } from "@/apps/contacts"
import { withRequestDeadline } from "@/utils/request-deadline"

export type AgentStatusEvent = Extract<Event, { type: "agent.status.updated" | "agent.status.removed" }>

/**
 * How a roster read recovers from a failure it did not cause.
 *
 * 🔴 **A FAILED READ OF "WHO WORKS HERE" IS NOT A FINAL ANSWER.**
 *
 * The roster is read once at server-context creation, before the instance is necessarily
 * answering. A slow start (the server builds its graph, resumes interrupted officers and begins
 * their turns) makes that first read fail — a CORS-refused preflight, a transport held behind one
 * — and the error then STAYED for the life of the window. Measured on packaged 0.1.83
 * (`%APPDATA%` log `20261001T223918`): `client-connected` fired ~32 s after `server-health`, the
 * renderer logged refused preflights at the moment it connected, and the roster error outlived the
 * connection. The tab strip reads the same list, so every colleague's portrait fell back to
 * initials with it.
 *
 * The reconnect engine already refetches on a `connected` transition, but that single attempt can
 * itself land in the tail of the same stall; when it fails there is no further transition to retry
 * on. This is the missing half: keep trying, at a bounded rate, until the instance answers. The
 * backoff is capped, so an instance that is genuinely gone is polled every 30 s rather than four
 * times a second — the same restraint `reconnect-schedule.ts` argues for.
 */
export interface RosterRetry {
  /** The first delay. */
  readonly baseMs?: number
  /** The ceiling a failure settles at instead of growing without bound. */
  readonly capMs?: number
}

const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 30_000

export function createAgentRoster(
  fetch: (signal: AbortSignal) => Promise<AgentLike[]>,
  timeoutMs = 10_000,
  retry: RosterRetry | false = {},
) {
  const [rows, setRows] = createSignal<readonly AgentLike[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const lifetime = new AbortController()
  const updates = new Map<string, AgentLike["status"]>()
  const baseMs = retry === false ? 0 : (retry.baseMs ?? RETRY_BASE_MS)
  const capMs = retry === false ? 0 : (retry.capMs ?? RETRY_CAP_MS)
  let pending: Promise<void> | undefined
  let queued = false
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const overlay = (agents: readonly AgentLike[]) =>
    agents.map((agent) => (updates.has(agent.id) ? { ...agent, status: updates.get(agent.id) } : agent))

  const cancelRetry = () => {
    if (retryTimer === undefined) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  onCleanup(() => {
    lifetime.abort()
    cancelRetry()
  })

  /**
   * A retry belongs to the lifetime, never to the read that scheduled it. `failures` only resets on
   * a SUCCESS or a caller-driven refetch, so an instance that is down is polled at the cap rather
   * than at the base after every miss.
   */
  const scheduleRetry = () => {
    if (retry === false || lifetime.signal.aborted || retryTimer !== undefined) return
    const delay = Math.min(capMs, baseMs * 2 ** Math.min(failures, 20))
    failures++
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void read()
    }, delay)
  }

  const read = (): Promise<void> => {
    if (lifetime.signal.aborted) return Promise.resolve()
    if (pending) {
      queued = true
      return pending
    }
    updates.clear()
    setLoading(true)
    pending = withRequestDeadline({ label: "Reading the roster", run: fetch, signal: lifetime.signal, timeoutMs })
      .then(
        (agents) => {
          if (lifetime.signal.aborted) return
          failures = 0
          cancelRetry()
          batch(() => {
            setRows(overlay(agents))
            setError(undefined)
          })
        },
        (failure: unknown) => {
          if (lifetime.signal.aborted) return
          setError(() => failure ?? new Error("The roster request failed"))
          scheduleRetry()
        },
      )
      .finally(() => {
        pending = undefined
        if (lifetime.signal.aborted) return
        setLoading(false)
        if (!queued) return
        queued = false
        return read()
      })
    return pending
  }

  /** A caller-driven refresh (a reconnect, or the user's Try again) earns a fresh, fast ladder. */
  const refetch = (): Promise<void> => {
    failures = 0
    cancelRetry()
    return read()
  }

  const applyStatus = (event: AgentStatusEvent) => {
    const status =
      event.type === "agent.status.updated"
        ? { task: event.properties.task, observed: event.properties.observed }
        : undefined
    if (pending) updates.set(event.properties.agent, status)
    const current = untrack(rows)
    const index = current.findIndex((agent) => agent.id === event.properties.agent)
    if (index < 0) return
    const agent = current[index]!
    if (agent.status?.task === status?.task && agent.status?.observed === status?.observed) return
    const next = current.slice()
    next[index] = { ...agent, status }
    setRows(next)
  }

  void read()
  return { list: rows, loading, error, refetch, applyStatus }
}
