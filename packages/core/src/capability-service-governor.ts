export * as CapabilityServiceGovernor from "./capability-service-governor"

import type { ConfigCapabilityService } from "./config/capability-service"

export const DEFAULT_QUEUE_LIMIT = 8

export interface MemoryCapacity {
  readonly limitBytes: number
  readonly usedBytes: number
  readonly floorUsedFraction: number
}

export type Phase = "stopped" | "loading" | "ready" | "busy" | "unloading" | "unavailable"

export interface Snapshot {
  readonly serviceID: string
  readonly phase: Phase
  readonly activeRequestID?: string
  readonly queuedRequestIDs: ReadonlyArray<string>
  readonly lastUsedMs: number
  readonly reason?: string
}

export type RequestDecision =
  | { readonly kind: "start"; readonly requestID: string }
  | { readonly kind: "run"; readonly requestID: string }
  | { readonly kind: "queued"; readonly position: number; readonly unload: ReadonlyArray<string> }
  | { readonly kind: "refused"; readonly reason: "disabled" | "unavailable" | "queue-full" }

export type Transition =
  | { readonly kind: "run"; readonly requestID: string }
  | { readonly kind: "stop"; readonly serviceID: string }
  | { readonly kind: "idle" }

interface Runtime {
  phase: Phase
  activeRequestID?: string
  queue: string[]
  lastUsedMs: number
  reason?: string
}

const initial = (): Runtime => ({ phase: "stopped", queue: [], lastUsedMs: 0 })
const queueLimit = (info: ConfigCapabilityService.Info) => info.queue_limit ?? DEFAULT_QUEUE_LIMIT

/**
 * Deterministic lifecycle/admission controller. It never launches a process itself: callers execute
 * the returned start/run/stop actions, then acknowledge the observed transition. This keeps retries,
 * cancellation and crash recovery outside the side effect they govern.
 */
export const make = () => {
  const runtimes = new Map<string, Runtime>()
  const runtime = (serviceID: string) => {
    const found = runtimes.get(serviceID)
    if (found !== undefined) return found
    const created = initial()
    runtimes.set(serviceID, created)
    return created
  }

  const safe = (capacity: MemoryCapacity | undefined, bytes: number) =>
    capacity !== undefined &&
    Number.isFinite(capacity.limitBytes) &&
    Number.isFinite(capacity.usedBytes) &&
    capacity.floorUsedFraction > 0 &&
    capacity.floorUsedFraction <= 1 &&
    capacity.usedBytes + bytes <= capacity.limitBytes * capacity.floorUsedFraction

  const idleVictims = (
    services: Readonly<Record<string, ConfigCapabilityService.Info>>,
    targetID: string,
    capacity: MemoryCapacity | undefined,
    required: number,
  ) => {
    if (capacity === undefined) return []
    let reclaimed = 0
    const selected: string[] = []
    const candidates = Object.keys(services)
      .filter((id) => id !== targetID && runtime(id).phase === "ready" && runtime(id).queue.length === 0)
      .toSorted((left, right) => runtime(left).lastUsedMs - runtime(right).lastUsedMs || left.localeCompare(right))
    for (const id of candidates) {
      selected.push(id)
      reclaimed += services[id]!.resources.estimated_resident_bytes
      if (safe({ ...capacity, usedBytes: Math.max(0, capacity.usedBytes - reclaimed) }, required)) break
    }
    if (!safe({ ...capacity, usedBytes: Math.max(0, capacity.usedBytes - reclaimed) }, required)) return []
    for (const id of selected) runtime(id).phase = "unloading"
    return selected
  }

  const enqueue = (state: Runtime, info: ConfigCapabilityService.Info, requestID: string, unload: string[]) => {
    const existing = state.queue.indexOf(requestID)
    if (existing >= 0) return { kind: "queued", position: existing + 1, unload: [] } as const
    if (state.queue.length >= queueLimit(info)) return { kind: "refused", reason: "queue-full" } as const
    state.queue.push(requestID)
    return { kind: "queued", position: state.queue.length, unload } as const
  }

  const request = (input: {
    readonly services: Readonly<Record<string, ConfigCapabilityService.Info>>
    readonly serviceID: string
    readonly requestID: string
    readonly capacity?: MemoryCapacity
    readonly nowMs: number
  }): RequestDecision => {
    const info = input.services[input.serviceID]
    if (info === undefined || info.disabled === true) return { kind: "refused", reason: "disabled" }
    const state = runtime(input.serviceID)
    if (state.activeRequestID === input.requestID) {
      return state.phase === "loading"
        ? { kind: "start", requestID: input.requestID }
        : { kind: "run", requestID: input.requestID }
    }
    if (state.phase === "unavailable") return { kind: "refused", reason: "unavailable" }
    if (state.phase === "loading" || state.phase === "busy" || state.phase === "unloading")
      return enqueue(state, info, input.requestID, [])

    const required =
      state.phase === "ready"
        ? Math.max(0, info.resources.estimated_peak_bytes - info.resources.estimated_resident_bytes)
        : info.resources.estimated_peak_bytes
    if (!safe(input.capacity, required)) {
      const existing = state.queue.indexOf(input.requestID)
      if (existing >= 0) return { kind: "queued", position: existing + 1, unload: [] }
      if (state.queue.length >= queueLimit(info)) return { kind: "refused", reason: "queue-full" }
      const unload = idleVictims(input.services, input.serviceID, input.capacity, required)
      return enqueue(state, info, input.requestID, unload)
    }

    state.activeRequestID = input.requestID
    state.lastUsedMs = input.nowMs
    if (state.phase === "stopped") {
      state.phase = "loading"
      return { kind: "start", requestID: input.requestID }
    }
    state.phase = "busy"
    return { kind: "run", requestID: input.requestID }
  }

  const loaded = (serviceID: string): Transition => {
    const state = runtime(serviceID)
    if (state.phase !== "loading" || state.activeRequestID === undefined) return { kind: "idle" }
    state.phase = "busy"
    return { kind: "run", requestID: state.activeRequestID }
  }

  const completed = (serviceID: string, nowMs: number): Transition => {
    const state = runtime(serviceID)
    if (state.phase !== "busy") return { kind: "idle" }
    state.lastUsedMs = nowMs
    state.phase = "ready"
    state.activeRequestID = undefined
    return { kind: "idle" }
  }

  /** Re-check the oldest queued request against CURRENT headroom after completion/unload/recovery. */
  const poll = (input: {
    readonly services: Readonly<Record<string, ConfigCapabilityService.Info>>
    readonly serviceID: string
    readonly capacity?: MemoryCapacity
    readonly nowMs: number
  }): RequestDecision | { readonly kind: "idle" } => {
    const state = runtime(input.serviceID)
    const requestID = state.queue.shift()
    if (requestID === undefined) return { kind: "idle" }
    return request({ ...input, requestID })
  }

  const cancel = (serviceID: string, requestID: string): Transition => {
    const state = runtime(serviceID)
    const queued = state.queue.indexOf(requestID)
    if (queued >= 0) {
      state.queue.splice(queued, 1)
      return { kind: "idle" }
    }
    if (state.activeRequestID !== requestID || (state.phase !== "loading" && state.phase !== "busy"))
      return { kind: "idle" }
    state.phase = "unloading"
    state.activeRequestID = undefined
    return { kind: "stop", serviceID }
  }

  const failed = (serviceID: string, reason: string) => {
    const state = runtime(serviceID)
    const affected = [state.activeRequestID, ...state.queue].filter((id): id is string => id !== undefined)
    state.phase = "unavailable"
    state.activeRequestID = undefined
    state.queue = []
    state.reason = reason
    return affected
  }

  const retry = (serviceID: string) => {
    const state = runtime(serviceID)
    if (state.phase !== "unavailable") return false
    runtimes.set(serviceID, initial())
    return true
  }

  const stopped = (serviceID: string) => {
    const state = runtime(serviceID)
    state.phase = "stopped"
    state.activeRequestID = undefined
    state.reason = undefined
  }

  const sweep = (services: Readonly<Record<string, ConfigCapabilityService.Info>>, nowMs: number) =>
    Object.keys(services)
      .sort()
      .filter((id) => {
        const state = runtime(id)
        const timeout = services[id]!.idle_timeout_ms
        if (state.phase !== "ready" || timeout === undefined || nowMs - state.lastUsedMs < timeout) return false
        state.phase = "unloading"
        return true
      })

  const snapshot = (): ReadonlyArray<Snapshot> =>
    [...runtimes.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([serviceID, state]) => ({
        serviceID,
        phase: state.phase,
        ...(state.activeRequestID === undefined ? {} : { activeRequestID: state.activeRequestID }),
        queuedRequestIDs: [...state.queue],
        lastUsedMs: state.lastUsedMs,
        ...(state.reason === undefined ? {} : { reason: state.reason }),
      }))

  return { request, poll, loaded, completed, cancel, failed, retry, stopped, sweep, snapshot }
}
