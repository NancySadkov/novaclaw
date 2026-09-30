export type SplashPhase = "starting" | "slow" | "stalled"

export const SPLASH_SLOW_MS = 8_000
export const SPLASH_STALLED_MS = 25_000

export function splashPhase(elapsedMs: number): SplashPhase {
  if (elapsedMs >= SPLASH_STALLED_MS) return "stalled"
  if (elapsedMs >= SPLASH_SLOW_MS) return "slow"
  return "starting"
}
