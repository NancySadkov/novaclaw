/**
 * 🔴 **The instance-scoped half of reconnect recovery.**
 *
 * When the event stream drops and comes back, `server.connected` fires and the client re-fetches
 * its world. That sweep enumerated `children.children` — the DIRECTORY stores — so anything whose
 * scope is the INSTANCE rather than a directory had no sweep at all, and stayed stale until the user
 * reloaded the page. Three loaders were in that gap: the tag list, presence (who is attached and who
 * is driving), and the persisted app manifests.
 *
 * ⚠️ **The class is what matters, not the three:** *a recovery sweep that enumerates one KIND of
 * state silently omits every other kind.* Enumerating directories is enumerating by type. This
 * enumerates by REGISTRATION, so a fourth piece of instance-scoped state is covered by the act of
 * registering it rather than by someone remembering to add a fourth line to a sweep it does not
 * resemble.
 *
 * ⚠️ **Registration does NOT run the bootstrap**, and the caller performs the first load by sweeping.
 * That is deliberate: a `register` that also ran would leave the initial load and the recovery load
 * as two code paths that can drift, which is the same shape as the bug. The first connect is just
 * the first recovery.
 *
 * 🔴 **A BOOTSTRAP MUST RETURN ITS PROMISE, or the sweep cannot see it fail.**
 *
 * `register` took `() => void` and every call site duly wrote `() => void session.loadTags()` — the
 * `void` operator discarding the promise INSIDE the callback, so `sweep` received `undefined`. Its
 * `try/catch` could therefore only ever catch a SYNCHRONOUS throw, and an async rejection escaped
 * every guard the wrapper had and landed as an unhandled rejection with no owner. Measured on the
 * owner's 0.1.81, 2026-09-29, the app's entire report of a bootstrap failure was Chromium's
 * `"Uncaught (in promise)"`, which names neither the bootstrap nor the error.
 *
 * The type is the fix, not a convention: requiring a `Promise` makes `() => void somePromise()`
 * stop compiling, so a bootstrap cannot be written in a shape the sweep is blind to. That is the
 * strongest rung — the wrong call no longer typechecks — rather than a comment asking for care.
 */
export interface InstanceRecovery {
  /** Add a bootstrap. Does not run it — the first `sweep()` does. Re-registering a name replaces it. */
  register(name: string, run: () => Promise<unknown>): void
  /**
   * Run every registered bootstrap. Called once at startup and again on every `server.connected`.
   *
   * Returns a promise that settles when all of them have, so a test can observe a sweep instead of
   * racing it. It never rejects — each bootstrap's failure is caught and recorded — so a caller that
   * ignores the result, as all of them do, cannot manufacture an unhandled rejection.
   */
  sweep(): Promise<void>
  /**
   * What failed in the most recent sweep, empty when it was clean.
   *
   * 🔴 **Recorded here, shown by the caller — deliberately not logged from this module.** A failure
   * reported only to `console.error` is the shape the silent-write ledger exists to refuse: nobody
   * without a console ever learns it happened, so the instance silently reads stale. This module
   * has no UI access by design, so it collects and `server-sync.tsx` — which can raise a calm toast
   * — decides. A low-level module that both swallowed the failure and shouted about it in a place
   * no person can reach was the defect; this is the half that gives the failure an owner.
   */
  failures(): readonly InstanceRecoveryFailure[]
  /** What is registered, for the guard that proves this set is not empty. */
  names(): readonly string[]
}

export interface InstanceRecoveryFailure {
  readonly name: string
  readonly error: unknown
}

export function createInstanceRecovery(): InstanceRecovery {
  const registered = new Map<string, () => Promise<unknown>>()
  let failures: InstanceRecoveryFailure[] = []
  return {
    register(name, run) {
      registered.set(name, run)
    },
    sweep() {
      // Each bootstrap is independent: one that fails must not strand the rest, because the whole
      // point of this pass is that the client heals after a fault rather than during a calm moment.
      const settled = [...registered].map(([name, run]) =>
        Promise.resolve()
          .then(run)
          .then(
            () => undefined,
            // The name travels with the error, so a failure identifies its own owner.
            (error: unknown) => ({ name, error }),
          ),
      )
      return Promise.all(settled).then((outcomes) => {
        failures = outcomes.filter((outcome): outcome is InstanceRecoveryFailure => outcome !== undefined)
      })
    },
    failures: () => failures,
    names: () => [...registered.keys()],
  }
}
