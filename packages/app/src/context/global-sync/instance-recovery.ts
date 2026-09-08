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
 */
export interface InstanceRecovery {
  /** Add a bootstrap. Does not run it — the first `sweep()` does. Re-registering a name replaces it. */
  register(name: string, run: () => void): void
  /** Run every registered bootstrap. Called once at startup and again on every `server.connected`. */
  sweep(): void
  /** What is registered, for the guard that proves this set is not empty. */
  names(): readonly string[]
}

export function createInstanceRecovery(): InstanceRecovery {
  const registered = new Map<string, () => void>()
  return {
    register(name, run) {
      registered.set(name, run)
    },
    sweep() {
      // Each bootstrap is independent: one that throws must not strand the rest, because the whole
      // point of this pass is that the client heals after a fault rather than during a calm moment.
      for (const run of registered.values()) {
        try {
          run()
        } catch {
          // The loaders own their own error reporting; a sweep is not the place to invent one.
        }
      }
    },
    names: () => [...registered.keys()],
  }
}
