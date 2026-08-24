export * as WorkerRegistry from "./worker-registry"

/**
 * WHICH SESSION WORKERS ARE ALIVE RIGHT NOW.
 *
 * 🔴 **Nothing knew this before.** `supervisor.ts` returns a pid to whoever spawned the worker and
 * that pid goes no further, so the instance had no fleet view at all — which is why every memory
 * bound in this product is per-worker or per-parent, and why N workers each "within limit" can still
 * exhaust the host with nobody able to notice. A ceiling on the SUM is impossible without this list.
 *
 * ⚠️ **Process-lifetime and deliberately not durable**, the same call `ColleagueBound` makes for its
 * rate window: a worker cannot outlive the process that spawned it, so a registry that survived a
 * restart could only ever be wrong — it would name pids that are gone, or worse, pids the OS has
 * since handed to something else. Killing a stranger because a stale row claimed it was ours is a
 * far worse failure than forgetting a fleet we no longer have.
 *
 * ⚠️ **`register` returns its own release rather than exposing `remove`.** The caller cannot forget
 * which pid it added, and cannot remove somebody else's.
 */

export interface Entry {
  readonly pid: number
  /** Whose turn this worker is running — so a warning names a chat a person can open. */
  readonly sessionID: string
  readonly startedAt: number
}

const live = new Map<number, Entry>()

/** Add a worker; the returned function removes exactly this one. Idempotent. */
export const register = (input: { readonly pid: number; readonly sessionID: string; readonly at: number }) => {
  const entry: Entry = { pid: input.pid, sessionID: input.sessionID, startedAt: input.at }
  live.set(input.pid, entry)
  let released = false
  return () => {
    if (released) return
    released = true
    // Only if it is still OURS: a pid can be reused, and removing a re-registered entry under the
    // same number would drop a live worker out of the fleet view.
    if (live.get(input.pid) === entry) live.delete(input.pid)
  }
}

/** Every live worker, newest last. */
export const entries = (): ReadonlyArray<Entry> => [...live.values()]

/** Just the pids — what the sampler wants. */
export const pids = (): ReadonlyArray<number> => [...live.keys()]

export const count = (): number => live.size

/** Test seam: forget every worker. */
export const reset = (): void => {
  live.clear()
}
