import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createAgentRoster, type AgentStatusEvent } from "@/context/agent-roster"
import type { AgentLike } from "@/apps/contacts"

const agent: AgentLike = { id: "nova", name: "Nova", mode: "primary", hidden: false, avatar: "/api/agent/nova/avatar" }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const status = (task: string): AgentStatusEvent => ({
  id: "evt_status",
  type: "agent.status.updated",
  properties: { agent: "nova", task, observed: 42 },
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("status updates keep portraits and never request the roster again", async () => {
  let reads = 0
  const { roster, dispose } = createRoot((dispose) => ({
    dispose,
    roster: createAgentRoster(async () => {
      reads++
      return [agent]
    }),
  }))
  try {
    await settle()
    for (let index = 0; index < 100; index++) roster.applyStatus(status(`Task ${index}`))
    expect(reads).toBe(1)
    expect(roster.list()[0]).toEqual({ ...agent, status: { task: "Task 99", observed: 42 } })
    expect(roster.loading()).toBe(false)
    const current = roster.list()
    roster.applyStatus(status("Task 99"))
    roster.applyStatus({ id: "evt_worker", type: "agent.status.removed", properties: { agent: "worker" } })
    expect(roster.list()).toBe(current)
    roster.applyStatus({ id: "evt_removed", type: "agent.status.removed", properties: { agent: "nova" } })
    expect(roster.list()[0]?.status).toBeUndefined()
    expect(roster.list()[0]?.avatar).toBe(agent.avatar)
  } finally {
    dispose()
  }
})

test("refreshes preserve the last roster through pending, failure and recovery", async () => {
  let response = deferred<AgentLike[]>()
  const { roster, dispose } = createRoot((dispose) => ({ dispose, roster: createAgentRoster(() => response.promise) }))
  try {
    response.resolve([agent])
    await settle()
    response = deferred()
    const refresh = roster.refetch()
    expect(roster.loading()).toBe(true)
    expect(roster.list()).toEqual([agent])
    response.reject(new Error("Connection lost"))
    await refresh
    expect(roster.list()).toEqual([agent])
    expect(roster.error()).toBeInstanceOf(Error)
    response = deferred()
    const recovery = roster.refetch()
    response.resolve([{ ...agent, name: "Recovered" }])
    await recovery
    expect(roster.error()).toBeUndefined()
    expect(roster.list()[0]?.name).toBe("Recovered")
  } finally {
    dispose()
  }
})

test("events arriving during a snapshot override the older response", async () => {
  const response = deferred<AgentLike[]>()
  const { roster, dispose } = createRoot((dispose) => ({ dispose, roster: createAgentRoster(() => response.promise) }))
  try {
    roster.applyStatus(status("New task"))
    response.resolve([agent])
    await settle()
    expect(roster.list()[0]?.status?.task).toBe("New task")
  } finally {
    dispose()
  }
})

test("refresh bursts share one request and one queued follow-up", async () => {
  const first = deferred<AgentLike[]>()
  let reads = 0
  const { roster, dispose } = createRoot((dispose) => ({
    dispose,
    roster: createAgentRoster(() => (++reads === 1 ? first.promise : Promise.resolve([agent]))),
  }))
  try {
    const requests = Array.from({ length: 100 }, () => roster.refetch())
    expect(reads).toBe(1)
    first.resolve([agent])
    await Promise.all(requests)
    expect(reads).toBe(2)
    expect(roster.loading()).toBe(false)
  } finally {
    dispose()
  }
})

test("a transport that never settles produces an actionable failure and is aborted", async () => {
  let signal!: AbortSignal
  const { roster, dispose } = createRoot((dispose) => ({
    dispose,
    roster: createAgentRoster((current) => {
      signal = current
      return new Promise(() => {})
    }, 5),
  }))
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(signal.aborted).toBe(true)
    expect(roster.loading()).toBe(false)
    expect(roster.error()).toBeInstanceOf(Error)
  } finally {
    dispose()
  }
})

test("disposing a server cancels its request and queued refresh", async () => {
  let reads = 0
  let signal!: AbortSignal
  const { roster, dispose } = createRoot((dispose) => ({
    dispose,
    roster: createAgentRoster((current) => {
      reads++
      signal = current
      return new Promise(() => {})
    }),
  }))
  const refresh = roster.refetch()
  dispose()
  await refresh
  expect(signal.aborted).toBe(true)
  expect(reads).toBe(1)
})

test("🔴 a transient roster failure heals itself without a manual refetch", async () => {
  let reads = 0
  const { roster, dispose } = createRoot((dispose) => ({
    dispose,
    roster: createAgentRoster(
      async () => {
        reads++
        if (reads === 1) throw new Error("Connection lost")
        return [agent]
      },
      10_000,
      { baseMs: 1, capMs: 2 },
    ),
  }))
  try {
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(roster.error()).toBeUndefined()
    expect(roster.list()[0]?.id).toBe("nova")
    expect(roster.loading()).toBe(false)
  } finally {
    dispose()
  }
})

test("🔴 a roster that stays unreachable is retried at a bounded rate and stops on dispose", async () => {
  let reads = 0
  const { roster, dispose } = createRoot((dispose) => ({
    dispose,
    roster: createAgentRoster(
      async () => {
        reads++
        throw new Error("Connection lost")
      },
      10_000,
      { baseMs: 1, capMs: 2 },
    ),
  }))
  try {
    await new Promise((resolve) => setTimeout(resolve, 40))
    const observed = reads
    expect(observed).toBeGreaterThanOrEqual(2)
    expect(roster.error()).toBeInstanceOf(Error)
    dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reads).toBe(observed)
  } finally {
    dispose()
  }
})

