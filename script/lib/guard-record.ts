/**
 * The `tmp/tsgo-guard.pid` record: `<pid> <unix ms>`, written by `script/tsgo-guard.ps1` every tick.
 *
 * 🔴 **Why a heartbeat and not just a pid.** The guard used to run until the machine rebooted, so a
 * pid file naming a live process was, in practice, the guard. Then the guard learned to reap itself
 * once `tsgo` has finished (2026-09-03 — it had been polling for 17.9 hours, 15.6 of them after the
 * last typecheck), and a leftover record became the NORMAL case rather than a rarity.
 *
 * PID reuse on Windows is real — `peak-sampler.ts` records one number appearing twice inside a single
 * gate — so a liveness test alone can be satisfied by a stranger wearing the dead guard's number.
 * The wrapper would read that as "the guard is up", start none, and typecheck unguarded while every
 * surface reported health. That is the same shape as an empty result and a failed query wearing one
 * face: two different facts, one answer. Both halves must agree, so both are recorded.
 *
 * Kept apart from `script/tsgo.ts` because that module RUNS a typecheck at import: logic that lives
 * there cannot be tested, only described.
 */

/** Anything older than this is a corpse or a stranger. The guard rewrites its record every 2 s. */
export const GUARD_STALE_MS = 15_000

export interface GuardRecord {
  readonly pid: number
  readonly beatMs: number
}

/**
 * Parse a record, or `undefined` when the text is not one.
 *
 * ⚠️ The OLD format was a bare pid with no timestamp. It parses to `undefined` here, so a record
 * written by a pre-2026-09-03 guard reads as "no guard standing" and a fresh one is started. That is
 * the safe direction of the two: the cost is one redundant guard, never an unguarded typecheck.
 */
export function parseGuardRecord(text: string): GuardRecord | undefined {
  const [pidText, beatText] = text.trim().split(/\s+/)
  const pid = Number(pidText)
  const beatMs = Number(beatText)
  if (!Number.isFinite(pid) || pid <= 0) return undefined
  if (!Number.isFinite(beatMs) || beatMs <= 0) return undefined
  return { pid, beatMs }
}

/**
 * Is a guard standing, according to this record?
 *
 * `isAlive` is injected so the decision can be exercised without a real process: the rule under test
 * is the AGREEMENT of the two halves, not the liveness syscall.
 */
export function isStandingGuard(
  text: string,
  now: number,
  isAlive: (pid: number) => boolean,
  staleMs: number = GUARD_STALE_MS,
): boolean {
  const record = parseGuardRecord(text)
  if (!record) return false
  if (!isAlive(record.pid)) return false
  // A beat from the future is a clock that moved, not a healthy guard; treat the distance either way.
  return Math.abs(now - record.beatMs) < staleMs
}
