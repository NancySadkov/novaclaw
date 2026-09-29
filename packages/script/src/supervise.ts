// Pure restart policy for supervised NovaClaw child processes. This dependency-free package is the
// shared boundary between the headless server and Electron main process; one implementation keeps
// their recovery behavior identical without either package reaching into the other's source tree.

export const RESTART_BACKOFF_START_MS = 1_000
export const RESTART_BACKOFF_CAP_MS = 30_000
export const BACKOFF_RESET_ALIVE_MS = 60_000
export const FAST_CRASH_MS = 10_000
export const FAST_CRASH_GIVEUP = 5
export const LIVENESS_FAILURE_LIMIT = 3

/**
 * 🔴 How long a child must stay up before its history is forgiven — a SECOND, much longer bound.
 *
 * Measured 2026-09-29 on a live instance: the server child was restarted at 01:18, 01:54 and 02:09,
 * and the desktop log carried `sidecar exited (code 1) - restarting in 1s` on a ~6-minute cycle going
 * back to 2026-09-23. The existing ladder could not stop it, because **both** of its forgiveness
 * thresholds are shorter than the child's actual lifetime:
 *
 *   - `fastCrashes` reset at `FAST_CRASH_MS` (10 s) and `backoffMs` reset at
 *     `BACKOFF_RESET_ALIVE_MS` (60 s), so a child that lived six minutes was scored as a healthy
 *     first start, every single time. `FAST_CRASH_GIVEUP` was unreachable in exactly the case it
 *     exists for;
 *   - so the loop ran forever, silently, restarting a broken server roughly every six minutes and
 *     reporting a normal `restarting` phase each time.
 *
 * The window has to be longer than any legitimately long-lived server, because the thing being
 * forgiven is *history*, not a transient. Sixty minutes: a server that survives an hour of real work
 * is not crash-looping, and the ones that are cannot reach it between restarts.
 */
export const HISTORY_RESET_ALIVE_MS = 60 * 60_000

/** A long-lived child that still died is a fault, and it is counted as one — just not a FAST one. */
export const SLOW_CRASH_GIVEUP = 3

export interface SuperviseState {
  readonly fastCrashes: number
  /** Faults since the last child that stayed up long enough to be forgiven. The slow-crash counter. */
  readonly slowCrashes: number
  readonly backoffMs: number
}

export const initialSuperviseState: SuperviseState = {
  fastCrashes: 0,
  slowCrashes: 0,
  backoffMs: RESTART_BACKOFF_START_MS,
}

export type SuperviseDecision =
  | { readonly action: "stop-clean" }
  | { readonly action: "giveup" }
  | { readonly action: "restart"; readonly delayMs: number; readonly next: SuperviseState }

export type LivenessDecision = {
  readonly action: "continue" | "restart"
  readonly failures: number
}

/**
 * Why a supervised child is gone — carried, never inferred from the exit code afterwards.
 *
 * 🔴 The distinction that matters is `intentional` vs everything else, and an exit code cannot
 * express it: our own sidecar exits **0** when the parent asks it to stop AND a buggy build can exit
 * 0 on a real fault, while a tree-kill of a healthy child on Windows reports a non-zero code for a
 * perfectly deliberate shutdown. Both supervisors therefore latch the intent at the moment they
 * decide to stop (`stopping`) and rewrite the code they hand {@link superviseDecision}. This union
 * is the same fact made reportable, so the UI can tell "we stopped it" from "it died" without
 * re-deriving the heuristic that does not work.
 */
export type StopReason = "intentional" | "crash" | "unresponsive" | "start-failed"

/**
 * What the supervisor is doing right now, in the terms a person needs.
 *
 * `gave-up` is a TERMINAL state and the reason this type exists: the restart ladder is bounded, so
 * something has to say when it has run out, or a UI that shows "reconnecting…" keeps promising a
 * recovery that nobody is attempting any more. `attempts` and `nextAttemptInMs` make the bounded
 * ladder legible while it is still climbing.
 */
export type SuperviseStatus =
  /**
   * 🔴 Spawned, and not yet observed to answer. This member exists because the alternative was a
   * LIE rather than a gap: with only `running | stopped | restarting | gave-up`, an owner that had
   * not yet spawned anything had to report `running`, and every reader — the renderer's connection
   * gate above all — was entitled to take that as "this instance is up".
   *
   * Measured 2026-09-28 in the packaged app (0.1.81): the gate was handed a `running` phase for an
   * instance whose port had not been bound yet, exhausted its own 10 s budget, and rendered
   *"Could not reach Local Server / Retrying automatically..."* against a server that came up healthy
   * 8.7 s in and was answering `/global/health` in 15 ms the whole time. A start in progress is not
   * an outage, and the vocabulary is what made the two indistinguishable.
   */
  | { readonly phase: "starting" }
  | { readonly phase: "running" }
  /** A deliberate stop — quit, relaunch, update. Never a fault, never counted, never telemetry. */
  | { readonly phase: "stopped" }
  | {
      readonly phase: "restarting"
      readonly reason: Exclude<StopReason, "intentional">
      /** 1 = the first retry after the first fault. */
      readonly attempt: number
      readonly nextAttemptInMs: number
    }
  | {
      readonly phase: "gave-up"
      readonly reason: Exclude<StopReason, "intentional">
      readonly attempts: number
    }

/** Consecutive probe failures only: one transient miss is not an outage, while a successful probe
 *  fully re-arms the monitor. The monitor plumbing owns intervals and process termination; keeping
 *  this decision pure makes desktop/headless parity mechanical. */
export function livenessDecision(failures: number, healthy: boolean): LivenessDecision {
  if (healthy) return { action: "continue", failures: 0 }
  const next = failures + 1
  return { action: next >= LIVENESS_FAILURE_LIMIT ? "restart" : "continue", failures: next }
}

/**
 * One child exit → what the supervisor does next.
 *
 * Exit 0 stops: an intentional shutdown must not be fought. Otherwise the fault is counted on TWO
 * ladders, because a crash loop has two shapes and the old policy could only see one.
 *
 * 🔴 **The fast ladder is for a child that never got going** — a bad path, a port already taken, a
 * crash on boot. `FAST_CRASH_GIVEUP` consecutive sub-`FAST_CRASH_MS` exits and it gives up, which is
 * right: the executable is broken and retrying cannot fix it.
 *
 * 🔴 **The slow ladder is for a child that ran for minutes and then died anyway**, and it is the one
 * that was missing. Measured 2026-09-29: this instance restarted its server child at 01:18, 01:54 and
 * 02:09, `code 1` each time, on a ~6-minute cycle. `fastCrashes` reset at 10 s, so each six-minute life
 * scored as a clean first start and `FAST_CRASH_GIVEUP` could never be reached — the loop was
 * structurally invisible to the one guard meant to catch it. A child that lives long enough to have
 * done real work and then dies is *still a fault*, and now it accumulates.
 *
 * ⚠️ Forgiving happens on ONE threshold, and it is the long one. Two thresholds is how the two
 * ladders came to disagree about what counted as healthy: a 60 s `backoffMs` reset and a 10 s
 * `fastCrashes` reset meant a child could be "healthy" for backoff purposes and "brand new" for
 * giveup purposes at the same time. `backoffMs` still resets sooner, because backing off for a long
 * run that then failed is not what the delay is for — but that reset no longer touches the counters.
 */
export function superviseDecision(state: SuperviseState, exit: { code: number; aliveMs: number }): SuperviseDecision {
  if (exit.code === 0) return { action: "stop-clean" }
  const forgiven = exit.aliveMs >= HISTORY_RESET_ALIVE_MS
  // ⚠️ A fast crash does NOT advance the slow counter. A child that dies on boot is one fault, and
  // counting it on both ladders meant a boot-crash loop reached the SLOW ceiling (3) in three
  // attempts — so the fast ladder's own, more specific diagnosis became unreachable, which is the
  // mirror of the bug this ladder was added to fix. The two shapes are counted separately and either
  // one alone is enough to give up.
  const fastCrashes = forgiven || exit.aliveMs >= FAST_CRASH_MS ? 0 : state.fastCrashes + 1
  const slowCrashes = forgiven || exit.aliveMs < FAST_CRASH_MS ? 0 : state.slowCrashes + 1
  if (fastCrashes >= FAST_CRASH_GIVEUP) return { action: "giveup" }
  // Checked AFTER the fast ladder, so a boot-crash still reports as a boot-crash: a child that dies in
  // 100 ms three times and then lives 5 minutes and dies is a slow crash, and only reaches here.
  if (slowCrashes >= SLOW_CRASH_GIVEUP) return { action: "giveup" }
  const backoffMs = exit.aliveMs >= BACKOFF_RESET_ALIVE_MS ? RESTART_BACKOFF_START_MS : state.backoffMs
  return {
    action: "restart",
    delayMs: backoffMs,
    next: { fastCrashes, slowCrashes, backoffMs: Math.min(backoffMs * 2, RESTART_BACKOFF_CAP_MS) },
  }
}
