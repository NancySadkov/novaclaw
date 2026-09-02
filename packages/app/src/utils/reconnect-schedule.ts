/**
 * The bounded retry schedule the per-server SSE loop reconnects on.
 *
 * 🔴 **A retry cadence with no ceiling is a denial of service you aimed at yourself.** The stream
 * loop used to wait a flat 250 ms and try again, with no attempt counter and no cap — so a stream
 * that will NEVER be allowed to connect (a rotated token, an auth proxy answering 401, a server
 * that is down precisely because it is overloaded) was re-requested about four times a second, per
 * configured instance, for the lifetime of the window. The one failure mode where restraint matters
 * most is the one the flat delay handled worst.
 *
 * The schedule is exponential from the base, capped, and then jittered DOWNWARD into the top half
 * of the interval, so N clients (or N instances in one client) that lost the same server do not
 * re-arrive in lockstep and re-create the thundering herd the cap was meant to prevent.
 *
 * Pure and separate from the loop so the SCHEDULE itself is assertable: a test that only observes
 * "it retried" cannot fail, and a test that measures wall-clock sleeps measures the machine.
 */

/** The first delay. Unchanged from the flat value it replaces, so a single blip still recovers fast. */
export const RECONNECT_BASE_MS = 250

/** The ceiling. A permanently rejected stream settles here instead of running at ~4 Hz forever. */
export const RECONNECT_CAP_MS = 30_000

/** The fraction of the ceiling a jittered delay may be reduced to, at most. */
const JITTER_FLOOR = 0.5

/**
 * The delay before retry number `attempt` (0-based, so `attempt` counts the failures SINCE the last
 * time this stream delivered data).
 *
 * `random` is injected so the ceiling sequence is exact under test; production passes nothing.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const steps = Math.max(0, Math.floor(attempt))
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(steps, 40))
  const factor = JITTER_FLOOR + Math.min(1, Math.max(0, random())) * (1 - JITTER_FLOOR)
  return Math.round(ceiling * factor)
}
