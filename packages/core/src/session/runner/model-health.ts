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

/**
 * Models the ENDPOINT has said it does not have.
 *
 * 🔴 A different kind of evidence from a failed turn, and it must not be counted like one. The
 * threshold above exists because a transport failure is weak evidence: a local server restarting
 * produces one, and demoting a colleague's model for it would be worse than waiting. A 404 saying
 * *"The model `x` does not exist"* is not weak and is not transient — it is the endpoint telling us
 * the catalog is WRONG, and the second turn will fail exactly like the first.
 *
 * Measured 2026-09-02 on a live instance: a chat pinned to `holo3.1` after the endpoint moved to
 * another model failed every turn. The catalog still listed the model, so `usableFallback` saw
 * nothing wrong; `healthyAlternative` needed two failures inside ten minutes; and this map is
 * process-lifetime, so restarting the app forgot the two and started counting again.
 *
 * ⚠️ Kept SEPARATE from the failure counts rather than "recording two failures at once", which would
 * have been the shorter change. A count that means "permanent" is a lie the next reader has to
 * decode, `succeeded` would silently clear it, and the window would expire something that has not
 * got better. This set is cleared only by a turn that actually WORKS on that model.
 */
const retiredModels = new Set<string>()

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
  // A turn that WORKED is the only thing that can un-retire a model: the endpoint served it, so
  // whatever made it answer "does not exist" is over. Without this line a model that came back
  // after a restart of the server would stay routed-around for the life of the process.
  retiredModels.delete(key(ref))
}

/**
 * Record an endpoint's own statement that it does not serve this model.
 *
 * Takes effect on the NEXT resolution with no threshold and no window — one such answer is all the
 * evidence there is going to be.
 */
export const retired = (ref: Ref): void => {
  retiredModels.add(key(ref))
}

/** Is this model currently failing badly enough to route around? */
export const sick = (ref: Ref, at: number): boolean =>
  retiredModels.has(key(ref)) || isSick(state.get(key(ref)) ?? [], at)

/** Has the endpoint said outright that it does not serve this model? Exported so a test asserts the
 * REASON and not only the verdict — "sick" and "not there" recover differently. */
export const isRetired = (ref: Ref): boolean => retiredModels.has(key(ref))

/** Test seam: forget everything. Never called in production — health is process-lifetime state. */
export const reset = (): void => {
  state.clear()
  retiredModels.clear()
}

/** How many failures are on record inside the window. Exported so a test asserts the count, not the verdict alone. */
export const failures = (ref: Ref, at: number): number => fresh(state.get(key(ref)) ?? [], at).length
