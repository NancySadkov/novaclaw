/**
 * The per-instance disposer registry — what runs when an instance is released.
 *
 * ⚠️ **Every disposer is NAMED, and a failure is REPORTED rather than swallowed.** This used to be a
 * `Set` of anonymous functions run through `Promise.allSettled(...)` whose results were discarded, so
 * a disposer that rejected did so in total silence: no log, no throw, nothing in the shutdown report.
 * And because the functions were anonymous, capturing those results would not have helped — there was
 * no way to say *which* subsystem failed to let go.
 *
 * That matters most at shutdown, which is exactly when nobody is watching: `Shutdown.describe` can
 * only name what was forced if the thing that failed had a name in the first place.
 */

/** A disposer that did not finish, and why. Success is the empty array. */
export interface DisposeFailure {
  readonly name: string
  readonly error: unknown
}

interface Entry {
  readonly name: string
  readonly dispose: (directory: string) => Promise<void>
}

const disposers = new Set<Entry>()

/**
 * Register a disposer under a name that will appear in a shutdown report.
 *
 * The name should say which SUBSYSTEM is being released ("location services", "instance cache"), not
 * what the callback does — it is read by someone looking at a stop that took too long.
 */
export function registerDisposer(name: string, dispose: (directory: string) => Promise<void>) {
  const entry: Entry = { name, dispose }
  disposers.add(entry)
  return () => {
    disposers.delete(entry)
  }
}

/**
 * Run every disposer for a directory and report the ones that failed.
 *
 * Still `allSettled`: one subsystem refusing to let go must not prevent the others from being
 * released — the remaining ones are typically the ones holding unflushed state. The difference is
 * that the outcome is now returned instead of dropped.
 */
export async function disposeInstance(directory: string): Promise<ReadonlyArray<DisposeFailure>> {
  const entries = [...disposers]
  const results = await Promise.allSettled(entries.map((entry) => entry.dispose(directory)))
  const failures: DisposeFailure[] = []
  for (const [index, result] of results.entries())
    if (result.status === "rejected") failures.push({ name: entries[index]!.name, error: result.reason })
  return failures
}

/**
 * Render failures for a log line — the NAME first, because that is the actionable part.
 *
 * ⚠️ Returns an array, not a joined string: the `list` attribute class takes `readonly string[]` and
 * `encodeList` owns the single bounded encoding. Joining here would have quietly opted out of that
 * bound and put an unbounded error message into a log line.
 */
export const describeDisposeFailures = (failures: ReadonlyArray<DisposeFailure>): ReadonlyArray<string> =>
  failures.map(
    (failure) =>
      `${failure.name} (${failure.error instanceof Error ? failure.error.message : String(failure.error)})`,
  )
