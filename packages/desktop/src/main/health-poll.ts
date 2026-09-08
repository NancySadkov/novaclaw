/**
 * A health poll that cannot outlive what it polls.
 *
 * 🔴 **WHY THIS IS A MODULE AND NOT A LOOP.** The sidecar's readiness gate used to be a bare
 * `while (true) { await sleep(100); if (await checkHealth(url)) return }` inside a
 * `Promise.race([ready(), childExited])`. Racing does not cancel: `Promise.race` settles the outer
 * promise and leaves the LOSER running. So a child that answered `ready` and then never answered
 * `/global/health` — a degraded database, a wedged layer — left one fetch every 100 ms for the life
 * of the app, and a child that simply exited left the same loop hammering a closed port forever.
 * Under the supervisor every respawn built another one, so the cost of the leak was the number of
 * times the app had recovered: the machine got worse the longer it stayed up, and only under the
 * real use that made it recover.
 *
 * ⚠️ The closure is the SIGNATURE, not a check inside it. `cancelled` and `timeoutMs` are required
 * arguments, so there is no way to spell an unbounded poll with this function — a caller cannot
 * forget the latch, because there is no overload that omits it. That is the difference between a
 * bug fixed and a bug made unspellable; a fresh `while (true)` beside this one would of course
 * reintroduce it, which is why the sidecar has exactly one poll and it is this one.
 *
 * ⚠️ Cancellation is a PREDICATE rather than an `AbortSignal` because the two facts that end this
 * poll — "the child exited" and "somebody asked us to stop" — are already plain latches in the
 * spawn closure. Wrapping them in a controller would add a second representation of the same state
 * and a second thing to keep in step.
 */

export type HealthPollResult = "healthy" | "cancelled"

export type HealthPollOptions = {
  /** One health probe. Must resolve `false` rather than throw for an ordinary failure. */
  readonly probe: () => Promise<boolean>
  /**
   * True as soon as the subject is gone or no longer wanted. Read BOTH before sleeping and after
   * waking: the interesting window is the one the poll spends asleep, and a latch that flipped
   * during it must not buy another probe.
   */
  readonly cancelled: () => boolean
  /** Gap between probes. */
  readonly intervalMs: number
  /**
   * How long a subject that stays alive and stays silent is allowed to keep us polling. Reaching it
   * REJECTS — a silent sidecar is a failure to report, not a quiet success.
   */
  readonly timeoutMs: number
  /** Seams for tests. Real time and real timers by default. */
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function pollUntilHealthy(options: HealthPollOptions): Promise<HealthPollResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? realSleep
  const deadline = now() + options.timeoutMs

  while (true) {
    if (options.cancelled()) return "cancelled"
    await sleep(options.intervalMs)
    // The latch is re-read after the sleep and before the probe, so a subject that died while we
    // waited costs zero further requests. This is the line the leak was missing.
    if (options.cancelled()) return "cancelled"
    if (await options.probe()) return "healthy"
    // Checked after a probe rather than before the sleep so a poll always makes at least one
    // attempt, and so the deadline describes elapsed time rather than a count of iterations.
    if (now() >= deadline)
      throw new Error(`health check did not pass within ${options.timeoutMs}ms and the subject is still alive`)
  }
}
