import type { Diagnosis, DiagnosisSignal } from "@/utils/resource-api"

/**
 * IS THE MEMORY ENGINE DEGRADED — one predicate, read by every surface that shows what NovaClaw
 * remembers.
 *
 * 🔴 Why it is shared rather than inlined twice. The `/memory/*` read handlers fold a `MemoryError`
 * into an EMPTY RESULT and answer 200 (`handlers/memory.ts`: `Effect.orElseSucceed(() => ({ nodes:
 * [], edges: [] }))`), which is a deliberate degrade — an outage must not fail a turn. The cost is
 * that "the engine is broken" and "you have no memories" arrive at the UI as the same bytes, so the
 * only thing that can tell them apart is the diagnosis board. The atlas asks it before it ever calls
 * an empty response an empty cabinet.
 *
 * ⚠️ A transport fault is a DIFFERENT question, answered by `pages/memory-graph/fault.ts`. That one
 * is "the request did not come back"; this one is "the request came back empty, and here is why".
 * Both end at the same calm sentence, and neither may end at the empty cabinet.
 */
export const MEMORY_SIGNAL = "memory"
export const WORLD_MEMORY_SIGNAL = "world-memory"

export const memorySignal = (diagnosis: Diagnosis | undefined): DiagnosisSignal | undefined =>
  diagnosis?.signals.find((signal) => signal.id === MEMORY_SIGNAL)

export const worldMemorySignal = (diagnosis: Diagnosis | undefined): DiagnosisSignal | undefined =>
  diagnosis?.signals.find((signal) => signal.id === WORLD_MEMORY_SIGNAL)

/**
 * `true` only when the board says PROBLEM.
 *
 * ⚠️ Never on `unknown`. The engine opens lazily, so a board read before anything has demanded memory
 * reports "not opened yet" — treating that as a fault would put an error in front of every user who
 * has simply not chatted yet, which is the opposite failure and just as wrong.
 */
export const memoryUnavailable = (diagnosis: Diagnosis | undefined): boolean =>
  memorySignal(diagnosis)?.status === "problem"

export const worldMemoryUnavailable = (diagnosis: Diagnosis | undefined): boolean =>
  worldMemorySignal(diagnosis)?.status === "problem"

/** The engine's own words for why, when the board carried them. */
export const memoryFaultDetail = (diagnosis: Diagnosis | undefined): string | undefined => {
  const signal = memorySignal(diagnosis)
  if (signal?.status !== "problem") return undefined
  const detail = signal.detail?.trim()
  return detail && detail.length > 0 ? detail : undefined
}

export const worldMemoryFaultDetail = (diagnosis: Diagnosis | undefined): string | undefined => {
  const signal = worldMemorySignal(diagnosis)
  if (signal?.status !== "problem") return undefined
  const detail = signal.detail?.trim()
  return detail && detail.length > 0 ? detail : undefined
}
