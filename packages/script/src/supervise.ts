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
