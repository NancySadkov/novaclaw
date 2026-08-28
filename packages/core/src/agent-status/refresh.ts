/**
 * WHEN a colleague's status line should be re-derived.
 *
 * Its own module, dependency-free, because this is the decision the periodic phase is made of and
 * every interesting case is a comparison of three numbers. Testing it through the phase would mean
 * a database, a model and a clock to assert something that is none of those.
 */

/** Refresh no more often than this, however busy the colleague is. */
export const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000

export type StatusRow = {
  /** Epoch millis of the newest activity the CURRENT label was derived from. */
  readonly observed: number
}

export type Candidate = {
  readonly agent: string
  /** Epoch millis of the colleague's newest activity, or `undefined` if it has none. */
  readonly latest: number | undefined
  /** The stored status, if this colleague has one yet. */
  readonly current: StatusRow | undefined
}

/**
 * Should this colleague's label be re-derived now?
 *
 * ⚠️ Three answers collapse into one predicate, and each is a real case:
 *
 *  * **no activity at all** — never. A colleague nobody has talked to has no task, and inventing a
 *    label for one would put words in its mouth. Contacts shows nothing rather than a guess.
 *  * **activity, no label yet** — always, regardless of the interval. The first thing a colleague
 *    does is exactly when the user most wants to see what it is doing, and making them wait three
 *    hours for the first line would make the feature look broken on the day it shipped.
 *  * **activity newer than the label, and the interval has passed** — refresh.
 *
 * ⚠️ `now` and both timestamps are passed in. A phase that read the clock itself could not be tested
 * for the boundary, and the boundary is the whole behaviour.
 */
export function shouldRefresh(candidate: Candidate, now: number): boolean {
  if (candidate.latest === undefined) return false
  if (candidate.current === undefined) return true
  // ⚠️ Strictly newer. Equal means the label already summarises the newest thing there is, and
  // re-deriving it would spend a model call to write the same sentence again — every interval,
  // forever, for a colleague that has stopped working.
  if (candidate.latest <= candidate.current.observed) return false
  return now - candidate.current.observed >= REFRESH_INTERVAL_MS
}

/**
 * The colleagues a pass should re-derive, in the order it should do them.
 *
 * ⚠️ Oldest observation first. A pass that runs out of budget — a model that is down, a shutdown
 * mid-sweep — then leaves the STALEST lines unrefreshed rather than a random subset, so the next
 * pass converges instead of thrashing over the same few.
 */
export function due(candidates: readonly Candidate[], now: number): readonly Candidate[] {
  return candidates
    .filter((candidate) => shouldRefresh(candidate, now))
    .sort((a, b) => (a.current?.observed ?? 0) - (b.current?.observed ?? 0))
}
