import { createRoot } from "solid-js"

/**
 * Give a promise-returning unit of work its own Solid owner, disposed the moment it settles.
 *
 * 🔴 **The class this closes: an owner-scoped acquisition made from a callback that has no owner
 * leaks its release, silently.** Anything reached through `createRefCountMap` registers its
 * decrement with `onCleanup`; `onCleanup` outside an owner warns and no-ops. So a caller running
 * from an SSE flush, a `setTimeout`, or a DOM listener increments a refcount that nothing will ever
 * decrement — and the damage is not local: the real UI consumer unmounting then decrements to N
 * instead of 0, so the resource's teardown (a query disabled, a pinned directory root released)
 * never runs at all. Nothing throws, nothing renders wrong, and the count only climbs while the
 * app is otherwise idle.
 *
 * ⚠️ The acquisition must happen in the SYNCHRONOUS prefix of `work` — before its first `await`.
 * That prefix is the only part that runs while this root is the current owner; everything after an
 * await runs with no owner again, exactly as it did before. Acquire first, then await.
 */
export function withTransientOwner<T>(work: () => Promise<T>): Promise<T> {
  return createRoot((dispose) => {
    let started: Promise<T>
    try {
      started = work()
    } catch (error) {
      dispose()
      return Promise.reject(error) as Promise<T>
    }
    return started.finally(dispose)
  })
}
