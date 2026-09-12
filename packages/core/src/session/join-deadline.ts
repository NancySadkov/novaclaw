/**
 * **THE bound on a join, for every door into it.**
 *
 * 🔴 **Raised from 2 minutes on 2026-08-20 because 2 minutes is shorter than one child's TURN.**
 * Measured: a child asked only to reply "BANANA" settled **121.7 seconds** after `wait` started, and
 * `wait` had given up 1.6 seconds earlier. Nothing was wrong; parent and child share one local model
 * server, so the child's single inference queued behind the parent's own. A join whose timeout is the
 * same order as one inference reports a false negative on a healthy run, which is exactly what a
 * supervisor must never do.
 *
 * ⚠️ It still has to be BOUNDED, so a wedged child cannot hold a caller forever. Seven minutes is
 * past a slow local turn and short enough for an officer to recover the slice in the same work turn.
 *
 * `tool/wait.ts` and `SessionV2.wait` share this value because two doors onto one question must not
 * be able to answer it differently. This tiny module is deliberately safe to import in the renderer:
 * the transcript can show the same deadline without pulling host/database code into the browser.
 *
 * Milliseconds, because this crosses the worker protocol and a `Duration` does not.
 */
export const JOIN_TIMEOUT_MS = 7 * 60_000
