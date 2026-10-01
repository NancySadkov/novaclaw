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

/**
 * The cadence while the shell says the instance is still STARTING.
 *
 * 🔴 **A START IS NOT AN OUTAGE, and running the outage ladder through one is what this cost.**
 * Measured 2026-09-28 across nine real boots of the packaged app: the gap between the supervisor
 * reporting the server healthy and the client actually connecting was **bimodal** — five boots at
 * 0.2–1.2 s, four boots at 27.7 s, 29.5 s, 29.8 s and 29.9 s. On the slow boots the server was
 * provably up, answering `/global/health` with `Access-Control-Allow-Origin: nc://renderer`, and its
 * own log recorded no client at all for 35 s.
 *
 * The cause is that `reconnectDelayMs` is a pure function of the failure count, and the client
 * burns attempts against a port that is not bound yet. Exhausted, that schedule sleeps 15.9–31.8 s
 * before the next try — which is the band the four slow boots landed in, jitter included. The
 * ladder's restraint is real and worth keeping: it exists so a server that is DOWN, or a rotated
 * token, is not re-requested four times a second forever. None of that applies while the local
 * shell is deliberately bringing the instance up, watching it, and holding it to a 60 s bound.
 *
 * So the client polls a start at a flat, short interval instead, and
 * {@link import("./context/reconnect-stream").runReconnectingStream} is told to discard the failures
 * it counted — they were earned against a server that did not exist — the moment the start ends.
 */
export const START_POLL_MS = 500

/**
 * The delay before a retry, for a client that knows whether the instance is on its way up.
 *
 * ⚠️ `starting` is a REQUIRED argument rather than an optional flag on purpose: a caller that forgets
 * it silently gets the outage ladder over a start, which is the defect this function exists to end.
 */
export function streamRetryDelayMs(
  input: { readonly attempt: number; readonly starting: boolean },
  random: () => number = Math.random,
): number {
  if (input.starting) return START_POLL_MS
  return reconnectDelayMs(input.attempt, random)
}

/** How long a settled stream may go quiet before the client treats it as dead. */
export const STREAM_HEARTBEAT_MS = 15_000

/**
 * How long a connection ATTEMPT may sit half-open while the instance is still STARTING.
 *
 * 🔴 **The retry cadence was not the whole stall.** `streamRetryDelayMs` bounds the wait BETWEEN
 * attempts; it says nothing about how long ONE attempt may hang. A port that is bound but not yet
 * answering (the server's graph still building, or its event loop starved by resumed officers)
 * accepts the TCP connection and then sends no headers. Only the idle heartbeat ends that attempt,
 * and the idle heartbeat must stay long — the server's own heartbeat cadence and a healthy quiet
 * stream are measured against it. So each half-open attempt cost the FULL 15 s, and the measured
 * boot paid it twice.
 *
 * Measured on packaged 0.1.83 (`%APPDATA%` log `20261001T223918`): the supervisor reported the
 * server healthy at 6.6 s, the renderer connected at 38.4 s, and the server answered `/api/agent`
 * in 0.28 s once reached — a ~32 s client stall, the shape of two 15 s attempts plus the waits
 * between them. The same 6.6 s → 38.4 s pair is on record across the 2026-09-28 boots.
 *
 * ⚠️ Short ONLY while `starting`. An instance that is DOWN has no supervisor saying so, and a
 * healthy-but-quiet stream must keep the long idle heartbeat; both keep `STREAM_HEARTBEAT_MS`.
 * A start is a countdown the shell is keeping, so re-probing it early costs one cheap request.
 */
export const STREAM_START_HEARTBEAT_MS = 3_000

export function streamHeartbeatMs(starting: boolean): number {
  return starting ? STREAM_START_HEARTBEAT_MS : STREAM_HEARTBEAT_MS
}
