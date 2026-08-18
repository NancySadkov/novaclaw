// Pure restart policy for supervised NovaClaw child processes. This dependency-free package is the
// shared boundary between the headless server and Electron main process; one implementation keeps
// their recovery behavior identical without either package reaching into the other's source tree.

export const RESTART_BACKOFF_START_MS = 1_000
export const RESTART_BACKOFF_CAP_MS = 30_000
export const BACKOFF_RESET_ALIVE_MS = 60_000
export const FAST_CRASH_MS = 10_000
export const FAST_CRASH_GIVEUP = 5
export const LIVENESS_FAILURE_LIMIT = 3

export interface SuperviseState {
  readonly fastCrashes: number
  readonly backoffMs: number
}

export const initialSuperviseState: SuperviseState = { fastCrashes: 0, backoffMs: RESTART_BACKOFF_START_MS }

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

/** One child exit → what the supervisor does next. Exit 0 stops (an intentional shutdown must not
 *  be fought); a fast crash climbs toward giveup; a long-lived child earns a backoff reset. */
export function superviseDecision(state: SuperviseState, exit: { code: number; aliveMs: number }): SuperviseDecision {
  if (exit.code === 0) return { action: "stop-clean" }
  const fastCrashes = exit.aliveMs < FAST_CRASH_MS ? state.fastCrashes + 1 : 0
  if (fastCrashes >= FAST_CRASH_GIVEUP) return { action: "giveup" }
  const backoffMs = exit.aliveMs >= BACKOFF_RESET_ALIVE_MS ? RESTART_BACKOFF_START_MS : state.backoffMs
  return {
    action: "restart",
    delayMs: backoffMs,
    next: { fastCrashes, backoffMs: Math.min(backoffMs * 2, RESTART_BACKOFF_CAP_MS) },
  }
}
