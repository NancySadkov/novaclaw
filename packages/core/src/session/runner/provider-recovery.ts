export * as ProviderRecovery from "./provider-recovery"

import type { ModelV2 } from "../../model"

export const BASE_DELAY_MS = 2_000
/**
 * The reconnect cadence ceiling — THIRTY minutes, per `invariants.md` (*Agent with unreachable model
 * provider*: *"trying to reconnect to its assigned model with intervals doubled each failure, up to
 * 30 minutes maximum interval"*).
 *
 * ⚠️ This read `10 * 60_000`, which was a divergence from the invariant rather than a preference:
 * the doubling stopped at ten minutes, so an endpoint that came back between minute ten and minute
 * thirty was never probed and the officer kept answering on its substitute long after its assigned
 * model was healthy again. The invariant is the contract; the number lives here so a test can bind
 * to it.
 */
export const MAX_DELAY_MS = 30 * 60_000

export interface Entry {
  readonly failures: number
  readonly next: number
}

export type State = Readonly<Record<string, Entry>>

export const key = (ref: { readonly providerID: string; readonly id: string }) => `${ref.providerID}/${ref.id}`

/** Exponential reconnect cadence: 2 s, 4 s, 8 s … capped at one attempt per thirty minutes. */
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

const capabilitiesUnknown = (capabilities: ModelV2.Capabilities): boolean =>
  !capabilities.tools && capabilities.input.length === 0 && capabilities.output.length === 0

/** A declared substitute must cover the assigned model; an empty profile is unknown, not a refusal. */
export const capabilitiesMatch = (
  required: ModelV2.Capabilities | undefined,
  candidate: ModelV2.Capabilities | undefined,
): boolean => {
  if (required === undefined || candidate === undefined) return true
  if (capabilitiesUnknown(required) || capabilitiesUnknown(candidate)) return true
  if (required.tools && !candidate.tools) return false
  return (
    required.input.every((kind) => candidate.input.includes(kind)) &&
    required.output.every((kind) => candidate.output.includes(kind))
  )
}

/**
 * HOW FAR a candidate's declared capabilities are from the unavailable model's — `invariants.md`:
 * *"if several available pick the one with closest matching capability"*.
 *
 * 🔴 **A COUNT, not a boolean, because `capabilitiesMatch` above is the VETO and this is the RANK.**
 * Once the veto has removed the candidates that cannot serve at all, every survivor may be a vast
 * over-provider (a frontier multi-modal cloud model as the only alternative to a local text model),
 * and choosing by catalog order or by the instance default is choosing by release calendar. The
 * distance counts BOTH directions — modalities the candidate has that the requirement does not, and
 * the reverse — so the substitution lands on the model that is closest to the one that was asked
 * for, not on the biggest one that happens to be available.
 *
 * ⚠️ An undefined or empty profile is NO EVIDENCE, never "no capabilities": a hand-added endpoint
 * usually declares nothing, and treating silence as an empty set would rank every such model as
 * maximally distant. Unknown profiles have distance zero; the veto above handles declared limits.
 */
export const capabilityDistance = (
  required: ModelV2.Capabilities | undefined,
  candidate: ModelV2.Capabilities | undefined,
): number => {
  if (required === undefined || candidate === undefined) return 0
  if (capabilitiesUnknown(required) || capabilitiesUnknown(candidate)) return 0
  const extra = (superset: readonly string[], subset: readonly string[]) =>
    superset.filter((kind) => !subset.includes(kind)).length
  return (
    (candidate.tools && !required.tools ? 1 : 0) +
    extra(candidate.input, required.input) +
    extra(candidate.output, required.output) +
    extra(required.input, candidate.input) +
    extra(required.output, candidate.output)
  )
}
