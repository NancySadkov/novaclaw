export * as ProviderRecovery from "./provider-recovery"

import type { ModelV2 } from "../../model"

export const BASE_DELAY_MS = 2_000
export const MAX_DELAY_MS = 10 * 60_000

export interface Entry {
  readonly failures: number
  readonly next: number
}

export type State = Readonly<Record<string, Entry>>

export const key = (ref: { readonly providerID: string; readonly id: string }) => `${ref.providerID}/${ref.id}`

/** Exponential reconnect cadence: 2 s, 4 s, 8 s … capped at one attempt per ten minutes. */
export const delayMs = (failures: number): number =>
  Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(30, Math.max(0, Math.floor(failures) - 1)))

export const decode = (value: unknown): State => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const result: Record<string, Entry> = {}
  for (const [id, candidate] of Object.entries(value)) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue
    const failures = (candidate as { failures?: unknown }).failures
    const next = (candidate as { next?: unknown }).next
    if (!Number.isInteger(failures) || (failures as number) < 1 || typeof next !== "number" || !Number.isFinite(next))
      continue
    result[id] = { failures: failures as number, next }
  }
  return result
}

/** Before `next` traffic routes around this model; at/after it, one request becomes the reconnect probe. */
export const unavailable = (state: State, ref: { readonly providerID: string; readonly id: string }, at: number) =>
  (state[key(ref)]?.next ?? 0) > at

/** The next route worth probing when every compatible route is inside its recovery window. */
export const earliest = <M extends { readonly providerID: string; readonly id: string }>(
  state: State,
  candidates: readonly M[],
): { readonly model: M; readonly next: number } | undefined => {
  let result: { readonly model: M; readonly next: number } | undefined
  for (const model of candidates) {
    const next = state[key(model)]?.next
    if (next === undefined || (result !== undefined && result.next <= next)) continue
    result = { model, next }
  }
  return result
}

export const failed = (state: State, ref: { readonly providerID: string; readonly id: string }, at: number): State => {
  const id = key(ref)
  const failures = (state[id]?.failures ?? 0) + 1
  return { ...state, [id]: { failures, next: at + delayMs(failures) } }
}

/**
 * Record an exhausted route. Its first turn already made the original request and one 2 s
 * reconnect; later recovery probes make exactly one request.
 */
export const exhausted = (
  state: State,
  ref: { readonly providerID: string; readonly id: string },
  at: number,
): State => {
  const id = key(ref)
  const failures = state[id] === undefined ? 2 : state[id]!.failures + 1
  return { ...state, [id]: { failures, next: at + delayMs(failures) } }
}

/** One successful reconnect clears the counter completely, so the next outage starts at two seconds. */
export const succeeded = (state: State, ref: { readonly providerID: string; readonly id: string }): State => {
  const id = key(ref)
  if (state[id] === undefined) return state
  const next = { ...state }
  delete next[id]
  return next
}

/** A substitute may equal or exceed every declared architectural capability of the unavailable model. */
export const capabilitiesMatch = (
  required: ModelV2.Capabilities | undefined,
  candidate: ModelV2.Capabilities | undefined,
): boolean => {
  if (required === undefined) return true
  if (candidate === undefined) return false
  if (required.tools && !candidate.tools) return false
  return (
    required.input.every((kind) => candidate.input.includes(kind)) &&
    required.output.every((kind) => candidate.output.includes(kind))
  )
}
