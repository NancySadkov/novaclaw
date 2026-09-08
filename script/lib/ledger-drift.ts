/**
 * Comparing an expected-failure ledger against what a run actually failed.
 *
 * 🔴 **This exists because the comparison it replaces was a naming lie with teeth.** `test.ts` carried
 * `const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])` — an ORDERED
 * comparison called `sameSet`. The baseline stores names alphabetically; a run reports them in
 * execution order, and a SHARDED run interleaves two shards' orders. So on 2026-08-06 a
 * `novaclaw:server` run whose 14 failures were exactly the 14 pinned names was reported as drift —
 * and because the `fresh`/`fixed` diffs it printed underneath are genuine set differences, both were
 * empty. The gate printed a red `EXPECTED-FAILURE DRIFT` header with NOTHING under it and exited 1.
 *
 * ⚠️ **That is ruling 2 — a fault described falsely — committed by the very file that enforces it.**
 * A bare header tells you a ledger moved and then refuses to say how, which is worse than silence: it
 * spends a real person's afternoon looking for a change that never happened. The shape below makes
 * that outcome unrepresentable, because the header is printed FROM the diffs rather than from a
 * separate boolean that can disagree with them.
 *
 * ⚠️ **Order-insensitive, but NOT duplicate-insensitive.** A sharded run that reports one test twice
 * is a real signal (the same test ran in both shards, or a shard was replayed), and collapsing to
 * `Set` would swallow it. `repeated` carries it as its own category instead of leaking out as a
 * phantom length mismatch — which is precisely how the original defect stayed invisible.
 */

export interface Drift {
  /** Failing now, not in the ledger — the regression case. */
  readonly fresh: ReadonlyArray<string>
  /** In the ledger, not failing now — fix it and shrink the ledger in the same commit. */
  readonly fixed: ReadonlyArray<string>
  /** Reported failing more times than the ledger pins it. Sharding artefact or a replayed shard. */
  readonly repeated: ReadonlyArray<string>
}

const tally = (names: ReadonlyArray<string>) => {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return counts
}

/**
 * What changed between the pinned list and this run's failures.
 *
 * Both inputs are treated as multisets: order never matters, multiplicity does.
 */
export const compute = (pinned: ReadonlyArray<string>, failing: ReadonlyArray<string>): Drift => {
  const want = tally(pinned)
  const got = tally(failing)
  const fresh: string[] = []
  const repeated: string[] = []
  for (const [name, count] of got) {
    const expected = want.get(name) ?? 0
    if (expected === 0) fresh.push(name)
    else if (count > expected) repeated.push(name)
  }
  const fixed = [...want.keys()].filter((name) => !got.has(name))
  return { fresh: fresh.sort(), fixed: fixed.sort(), repeated: repeated.sort() }
}

/**
 * True when the run matches the ledger exactly.
 *
 * 🔴 Derived from the diffs, never computed alongside them. The original defect was two answers to
 * one question that were allowed to disagree; there is only one answer here.
 */
export const clean = (drift: Drift): boolean =>
  drift.fresh.length === 0 && drift.fixed.length === 0 && drift.repeated.length === 0
