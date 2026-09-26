/**
 * The commit-charge ceiling a run unit's own tree may reach before the gate tree-kills it.
 *
 * Pure and tested, because the interesting part is a JUDGEMENT rather than a measurement: where a
 * kill line sits so a ballooning unit dies while a healthy-but-hot one never notices it.
 *
 * ─── WHY A KILL, AND WHY NOW ────────────────────────────────────────────────────────────────
 *
 * `test.ts` deliberated this kill and deferred it ("enable a kill only after these lines have been
 * observed across several full gates"). The observations are in: the 2026-07-20 OOM that took the
 * laptop down, and 2026-09-26, when a `core` gate committed ~31 GB on a 32 GB box and the machine
 * rebooted out from under the run. A suite with a wall-clock kill but no memory kill protects the
 * terminal and abandons the machine — and the vision's "never breaks in your hands" stops at the
 * suite's edge.
 *
 * ─── WHY TWICE THE PROFILE ──────────────────────────────────────────────────────────────────
 *
 * The cap is anchored to the unit's own worst HEALTHY run (`peaks`), not to the box: twice the
 * profile cannot false-kill a unit running normally, because normal never reaches it by a factor
 * of two. The box enters only as a sanity bound — a cap above what the machine can survive
 * protects nothing (see `MAX_KILL_CAP_FRACTION_OF_COMMIT`).
 *
 * A kill is NOT a measurement: `peak-series.ts` withholds a capped run's peak under the "capped"
 * status, exactly as it withholds sharded and concurrent ones. A ceiling artifact must never
 * become a profile, or the next cap would be derived from this kill.
 */

export const KILL_FACTOR = 2

/** Below this a cap is noise rather than protection — no profiled unit is this small. */
export const MIN_KILL_CAP_MB = 4096

/**
 * Fraction of the machine's commit limit a single unit tree may ever hold. Above it the cap stops
 * describing the unit and starts describing the box: foreign demand (a dev server, Defender, the
 * previous unit's unreaped orphans) eats the same commit, and a cap that ignores them is a machine
 * killer wearing a unit's name.
 */
export const MAX_KILL_CAP_FRACTION_OF_COMMIT = 0.625

/**
 * The kill line for one spawn of a unit, or undefined when there is no number to anchor it to.
 *
 * An UNPROFILED unit gets no cap: inventing one from nothing is how a healthy unit dies for being
 * measured for the first time. The planner profiles units into existence; enforcement follows
 * measurement, never precedes it.
 */
export function killCapMb(
  profilePeakMb: number | undefined,
  commitLimitMb: number | undefined,
): number | undefined {
  if (profilePeakMb === undefined || !Number.isFinite(profilePeakMb) || profilePeakMb <= 0) return undefined
  const anchored = Math.max(KILL_FACTOR * profilePeakMb, MIN_KILL_CAP_MB)
  if (commitLimitMb === undefined || !Number.isFinite(commitLimitMb) || commitLimitMb <= 0) return anchored
  return Math.min(anchored, Math.floor(MAX_KILL_CAP_FRACTION_OF_COMMIT * commitLimitMb))
}
