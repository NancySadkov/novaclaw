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
 * 🔴 WHAT ONE RUN MAY HOLD, IN MB — the machine's standing promise, not a fraction of it.
 *
 * This replaces a bound expressed as `0.625 × the machine's commit limit`, which on a 32 GB laptop
 * permitted ~20 GB for a single test run. That number scaled with the BOX rather than with what the box
 * can spare, and the box cannot spare it: the user's browser, editor and agent runtime live on the same
 * commit. Measured 2026-09-27, a `core` run held ~10 GB — comfortably inside its ~20 GB ceiling — and
 * the host still reached 100 % commit, so Windows reaped the browser and the editor. The cap was not
 * breached; the machine died of everything the cap does not measure.
 *
 * 8 GB is what this class of machine can guarantee for one run while a person is using it. It is an
 * ABSOLUTE allowance on purpose. A fraction is right when the concern is "don't take the whole
 * machine"; the concern here is "leave the machine usable", and only an absolute number says that.
 * On a larger box this stays 8 GB rather than growing, because the thing being protected is the user's
 * session, not the silicon.
 *
 * ⚠️ The consequence is deliberate and must not be discovered by surprise: `core`'s own recorded
 * healthy peak is 10,822 MB, so a WHOLE `core` run is killed here having produced no count. Sharding
 * is what makes it completable, and the memory planner already chooses that. A fast, predictable kill
 * at 8 GB is the trade; a slow one that reaps the desktop is not.
 */
export const MACHINE_ALLOWANCE_MB = 8_192

/**
 * Fraction of the machine's commit limit a single unit tree may ever hold, as a last-resort sanity
 * bound for a machine far larger than the allowance. It can only ever TIGHTEN the cap: a tiny fraction
 * on a small box would make the allowance unreachable, which is why this is a ceiling on the ceiling
 * rather than the thing that sets it.
 */
export const MAX_KILL_CAP_FRACTION_OF_COMMIT = 0.625

/**
 * The kill line for one spawn of a unit, or undefined when there is no number to anchor it to.
 *
 * Two bounds, and they answer different questions. The PROFILE anchor (`twice the unit's own worst
 * healthy run`) is about not false-killing a unit that is behaving. The ALLOWANCE is about the machine
 * staying usable, and it does not care what the unit normally does. The smaller wins, so a unit can
 * never raise its way past what the laptop can spare — otherwise the anchor alone would hand `core`
 * ~21 GB on any machine with a large commit limit.
 *
 * An UNPROFILED unit gets no cap: inventing one from nothing is how a healthy unit dies for being
 * measured for the first time. The planner profiles units into existence; enforcement follows
 * measurement, never precedes it.
 */
export function killCapMb(
  profilePeakMb: number | undefined,
  allowanceMb: number = MACHINE_ALLOWANCE_MB,
): number | undefined {
  if (profilePeakMb === undefined || !Number.isFinite(profilePeakMb) || profilePeakMb <= 0) return undefined
  const anchored = Math.max(KILL_FACTOR * profilePeakMb, MIN_KILL_CAP_MB)
  // 🔴 A nonsense allowance FALLS BACK TO THE DEFAULT, never to "no bound". Returning `anchored` here
  // would hand a core run its full 21,644 MB anchor because someone passed a bad number — i.e. a typo
  // in a config would silently restore the exact ceiling that reaped the desktop. A guard that can be
  // switched off by a bad value is not a guard.
  const allowance =
    allowanceMb === undefined || !Number.isFinite(allowanceMb) || allowanceMb <= 0 ? MACHINE_ALLOWANCE_MB : allowanceMb
  return Math.min(anchored, Math.floor(allowance))
}

/**
 * The same line, additionally bounded by the box on a machine whose commit limit is the binding
 * constraint. Kept separate so the ALLOWANCE is the thing a reader finds first: on a 32 GB laptop the
 * fraction alone permitted ~20 GB, which is the number that caused the incident.
 */
export function killCapMbForBox(
  profilePeakMb: number | undefined,
  commitLimitMb: number | undefined,
  allowanceMb: number = MACHINE_ALLOWANCE_MB,
): number | undefined {
  const base = killCapMb(profilePeakMb, allowanceMb)
  if (base === undefined) return undefined
  if (commitLimitMb === undefined || !Number.isFinite(commitLimitMb) || commitLimitMb <= 0) return base
  return Math.min(base, Math.floor(MAX_KILL_CAP_FRACTION_OF_COMMIT * commitLimitMb))
}
