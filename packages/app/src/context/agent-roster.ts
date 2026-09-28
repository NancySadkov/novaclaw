import { batch, createSignal, onCleanup, untrack } from "solid-js"
import type { Event } from "@novaclaw/sdk/v2/client"
import type { AgentLike } from "@/apps/contacts"
import { withRequestDeadline } from "@/utils/request-deadline"

export type AgentStatusEvent = Extract<Event, { type: "agent.status.updated" | "agent.status.removed" }>

export function createAgentRoster(fetch: (signal: AbortSignal) => Promise<AgentLike[]>, timeoutMs = 10_000) {
  const [rows, setRows] = createSignal<readonly AgentLike[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const lifetime = new AbortController()
  const updates = new Map<string, AgentLike["status"]>()
  let pending: Promise<void> | undefined
  let queued = false
  onCleanup(() => lifetime.abort())

  const overlay = (agents: readonly AgentLike[]) =>
    agents.map((agent) => (updates.has(agent.id) ? { ...agent, status: updates.get(agent.id) } : agent))

  const refetch = (): Promise<void> => {
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
          batch(() => {
            setRows(overlay(agents))
            setError(undefined)
          })
        },
        (failure: unknown) => {
          if (!lifetime.signal.aborted) setError(() => failure ?? new Error("The roster request failed"))
        },
      )
      .finally(() => {
        pending = undefined
        if (lifetime.signal.aborted) return
        setLoading(false)
        if (!queued) return
        queued = false
        return refetch()
      })
    return pending
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

  void refetch()
  return { list: rows, loading, error, refetch, applyStatus }
}
