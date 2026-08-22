export * as ModelHealth from "./model-health"

// A model that is FAILING, and the temporary switch away from it (owner, 2026-08-21: *"if the agent's
// chosen model is unavailable / gives errors, we temporarily auto switch to the Default model"*).
//
// 🔴 **"Unavailable" and "gives errors" are two different faults and only one of them was handled.**
// `runner/model.ts` already covers the first: a model the catalog cannot resolve falls back at
// resolution time. But a model that resolves perfectly and then 500s on every request is the more
// common failure — a local server that died, a key that expired, a context window the endpoint no
// longer serves — and under the old behaviour the colleague configured to use it simply stopped
// answering, turn after turn, with the fault reported as its own.
//
// ⚠️ **IN MEMORY, deliberately.** "Temporarily" is the owner's word and the config is never written:
// the user's choice survives, the switch lasts as long as the endpoint is sick, and a restart is a
// clean slate — which is right, because the usual repair for a dead local server IS a restart.
//
// ⚠️ **Two failures, not one.** A single failed turn is a blip: a local model restarting mid-request
// hits `Transport` and the retry loop already covers it. Demoting on one would have every colleague
// drift off its configured model the first time a laptop swapped. What this is looking for is an
// endpoint that fails, gets retried to exhaustion, and fails again — a pattern a healthy model does
// not produce. (`threshold-that-fires-on-normal-is-not-a-threshold`.)

/** How long a failure keeps counting toward "this endpoint is sick". */
export const WINDOW_MS = 10 * 60_000

/** Failed turns inside the window before a model is treated as sick. */
export const THRESHOLD = 2

/** The catalog identity a health record hangs off. Provider included: the same model id served by two providers is two endpoints. */
export interface Ref {
  readonly providerID: string
  readonly id: string
}

export const key = (ref: Ref): string => `${ref.providerID}/${ref.id}`

/**
 * The decision, as a pure function of what has been seen. Separated from the store so the rule can be
 * tested without a clock or a runner — and so the rule and the bookkeeping cannot drift apart.
 */
export const isSick = (failures: readonly number[], at: number): boolean =>
  failures.filter((when) => at - when <= WINDOW_MS).length >= THRESHOLD

/** Drop failures that have aged out, so a long-lived process does not accumulate them forever. */
export const fresh = (failures: readonly number[], at: number): number[] =>
  failures.filter((when) => at - when <= WINDOW_MS)

const state = new Map<string, number[]>()

/** Record a turn that failed on this model. */
export const failed = (ref: Ref, at: number): void => {
  const id = key(ref)
  state.set(id, [...fresh(state.get(id) ?? [], at), at])
}

/**
 * Record a turn that WORKED on this model, which clears its history outright.
 *
 * ⚠️ Clears rather than decrements: the question is "is this endpoint serving right now", and one
 * successful turn answers it. Decaying instead would keep a model that has visibly recovered demoted
 * for the rest of the window — the user restarts their local server and the next turn still runs on
 * something else, with nothing on screen explaining why.
 */
export const succeeded = (ref: Ref): void => {
  state.delete(key(ref))
}

/** Is this model currently failing badly enough to route around? */
export const sick = (ref: Ref, at: number): boolean => isSick(state.get(key(ref)) ?? [], at)

/** Test seam: forget everything. Never called in production — health is process-lifetime state. */
export const reset = (): void => {
  state.clear()
}

/** How many failures are on record inside the window. Exported so a test asserts the count, not the verdict alone. */
export const failures = (ref: Ref, at: number): number => fresh(state.get(key(ref)) ?? [], at).length
