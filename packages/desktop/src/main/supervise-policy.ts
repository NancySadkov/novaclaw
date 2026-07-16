// Dependability P3: the pure sidecar restart policy. MIRROR of
// packages/novaclaw/src/cli/supervise.ts (the headless serve twin) — keep the two in sync; it is
// duplicated rather than imported so the Electron main bundle doesn't grow a CLI-package edge.

export const RESTART_BACKOFF_START_MS = 1_000
export const RESTART_BACKOFF_CAP_MS = 30_000
export const BACKOFF_RESET_ALIVE_MS = 60_000
export const FAST_CRASH_MS = 10_000
export const FAST_CRASH_GIVEUP = 5

export interface SuperviseState {
  readonly fastCrashes: number
  readonly backoffMs: number
}

export const initialSuperviseState: SuperviseState = { fastCrashes: 0, backoffMs: RESTART_BACKOFF_START_MS }

export type SuperviseDecision =
  | { readonly action: "stop-clean" }
  | { readonly action: "giveup" }
  | { readonly action: "restart"; readonly delayMs: number; readonly next: SuperviseState }

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
