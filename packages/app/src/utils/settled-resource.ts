import { createMemo, createResource } from "solid-js"

/**
 * **A `createResource` whose accessor cannot throw, and which can tell a failure from an empty
 * answer.**
 *
 * 🔴 **The class this closes.** *A failure folded into the same value an absent one produces.*
 * Ruling 2 states both halves — a failed mutation never reports success, and an unavailable
 * subsystem names itself instead of rendering empty — and the tree violated them at every layer,
 * because nothing in the types distinguished *empty* from *failed*. Six list viewers said "you have
 * none yet" over a listing that never arrived; two more handed the outage to the root
 * `ErrorBoundary` and replaced the whole application.
 *
 * ⚠️ **Why the plain primitive makes both mistakes easy, read out of `solid-js/dist/solid.cjs`
 * rather than from prose:**
 *
 * - `read()` re-throws the stored error (`if (err !== undefined && !pr) throw err`), so the throw
 *   lives in the **accessor**, not in the fetcher. The defect and its symptom are different
 *   expressions in different lines, and the unguarded call is the shorter one.
 * - **`.latest` throws too, and an `initialValue` does not save it.** Its getter re-throws whenever
 *   `resolved` is set — and `resolved` is initialised to `"initialValue" in options`. So the
 *   spelling that *reads* like the safe one is not, and a sweep that classified
 *   `initialValue: []` sites as "guarded" was wrong about every one of them.
 * - **`initialValue` also erases "not asked yet".** Without it a resource whose source is nullish
 *   sits at `"unresolved"`; with it the state is `"ready"` before anything has been requested, so
 *   the value a viewer renders on a cold client is indistinguishable from a real empty answer.
 * - A fetcher that throws **synchronously** never reaches a `.catch` on its result — Solid catches
 *   it itself and marks the resource `errored`, which is the same dead end by a shorter route.
 *
 * **What this returns instead.** An accessor that is total, plus three booleans that are the whole
 * vocabulary a viewer needs:
 *
 * | reading | means |
 * |---|---|
 * | `idle` | the source is nullish — **nothing has been asked** |
 * | `loading` | a request is in flight |
 * | `failed` | the request **ran and did not answer** |
 * | neither | the request answered; the accessor holds what it said |
 *
 * ⚠️ **The failure is carried as a private sentinel, not as `undefined`.** A fetcher that legitimately
 * resolves to `undefined` is a SUCCESS, and folding it together with a rejection is the very defect
 * this module exists to remove — one layer down, in the helper everybody trusts. The sentinel is not
 * exported and cannot escape: `value()` maps it back to `undefined`, and only `failed` can see it.
 *
 * ⚠️ **`state` is derived, never Solid's own.** Solid's `"ready"` means *the fetcher returned*, which
 * here includes returning the failure sentinel.
 */

/** The one value that means "the fetcher rejected". Module-private on purpose — see above. */
const FAILED = Symbol("novaclaw.settled-resource.failed")
type Failed = typeof FAILED

/**
 * Precedence, and it is the same in `list-state.ts`: **failed > loading > idle > ready.**
 *
 * A known failure outranks a retry in flight, so a refetch after an outage keeps naming the outage
 * instead of flickering back through "loading" to an empty-looking screen; and only a settled,
 * unfailed read may ever be reported as ordinary content.
 */
export type SettledState = "idle" | "loading" | "failed" | "ready"

export interface SettledResource<T> {
  /** The last value the fetcher produced, or `undefined`. **Never throws.** */
  (): T | undefined
  readonly state: SettledState
  /** Nothing has been asked: the source is `undefined`, `null` or `false`. */
  readonly idle: boolean
  /** A request is in flight. */
  readonly loading: boolean
  /** The request ran and did not answer. Stays true across a refetch until a new answer lands. */
  readonly failed: boolean
}

export interface SettledActions<T> {
  /** Re-run the fetcher. Returns whatever Solid's own `refetch` does, so `await` still works. */
  readonly refetch: (info?: unknown) => unknown
  /** Replace the held value without fetching. */
  readonly mutate: (value: T | undefined) => void
}

export interface SettledFetcherInfo<T> {
  /** The previous value, with a previous FAILURE reported as `undefined` rather than leaking. */
  readonly value: T | undefined
  readonly refetching: unknown
}

/**
 * Create a resource whose accessor is total.
 *
 * The fetcher is written exactly as it would be for `createResource` — and **without a `.catch`**:
 * a rejection is this helper's business, and a fetcher that swallows its own failure hides it from
 * `failed` and puts the lie back.
 */
export function createSettledResource<T, S>(
  source: () => S | undefined | null | false,
  fetcher: (source: S, info: SettledFetcherInfo<T>) => T | Promise<T>,
): [SettledResource<T>, SettledActions<T>] {
  const src = createMemo(source)
  const idle = createMemo(() => {
    const value = src()
    return value === undefined || value === null || value === false
  })

  const [raw, actions] = createResource<T | Failed, S>(src, async (value, info) => {
    // `async` is load-bearing: it converts a SYNCHRONOUS throw in the caller's fetcher into a
    // rejection this `catch` can see, which a `.catch` on the returned promise cannot do.
    try {
      const previous = info.value === FAILED ? undefined : (info.value as T | undefined)
      return await fetcher(value, { value: previous, refetching: info.refetching })
    } catch {
      return FAILED
    }
  })

  /**
   * The only place the underlying accessor is read, and it is read only in the two states where
   * reading it cannot throw. `"errored"` is unreachable through the wrapper above and is mapped to
   * a failure anyway, because a helper whose safety depends on a branch being unreachable is one
   * refactor away from not being safe.
   */
  const settled = createMemo<T | Failed | undefined>(() => {
    const state = raw.state
    if (state === "errored") return FAILED
    if (state === "ready" || state === "refreshing") return raw()
    return undefined
  })

  const failed = createMemo(() => settled() === FAILED)
  const value = createMemo<T | undefined>(() => {
    const held = settled()
    return held === FAILED ? undefined : held
  })

  const read = () => value()
  Object.defineProperties(read, {
    idle: { get: () => idle() },
    loading: { get: () => raw.loading },
    failed: { get: () => failed() },
    state: {
      get: (): SettledState => (failed() ? "failed" : raw.loading ? "loading" : idle() ? "idle" : "ready"),
    },
  })

  return [
    read as unknown as SettledResource<T>,
    {
      refetch: (info?: unknown) => actions.refetch(info),
      mutate: (next: T | undefined) => {
        ;(actions.mutate as unknown as (updater: () => T | undefined) => void)(() => next)
      },
    },
  ]
}

/**
 * **The read RAN and produced nothing usable** — as distinct from "not asked" and "still asking".
 *
 * ⚠️ For a source that answers with a falsy placeholder instead of rejecting. `GET /path` is the
 * live example: `resolveInstanceGlobalDirectory` folds a failed lookup into `""`, which every caller
 * gates on, so a panel keyed on it sits at `idle` forever and shows a spinner that will never
 * resolve. That is the same lie as an empty list, wearing a different animation. Pass this to
 * `createListState`'s `failedWhen` so the panel names the fault instead.
 */
export function answeredNothing(resource: SettledResource<unknown>): boolean {
  return resource.state === "ready" && !resource()
}
