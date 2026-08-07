/**
 * What the startup splash SAYS, as a function of how long it has been saying it.
 *
 * The window now opens immediately instead of after the sidecar settles (see `main/boot.ts`), which
 * means the splash is the first thing a user sees on every launch — including the launches that go
 * wrong. A pulsing logo alone cannot tell a slow start from a dead one, and `AGENTS.md` asks the
 * product to teach as it works, so the splash escalates: what is happening, then that it is slower
 * than usual, then what the user can expect next. No spinner-shaped lie, no stack trace.
 *
 * The thresholds sit under the main process's own bounds on purpose — the spawn stall timer is 60 s
 * and the health gate 30 s — so the user is told it is slow well before either fires, and the
 * renderer's error page (or the connection banner) takes over when one does.
 */
export type SplashPhase = "starting" | "slow" | "stalled"

export const SPLASH_SLOW_MS = 8_000
export const SPLASH_STALLED_MS = 25_000

export function splashPhase(elapsedMs: number): SplashPhase {
  if (elapsedMs >= SPLASH_STALLED_MS) return "stalled"
  if (elapsedMs >= SPLASH_SLOW_MS) return "slow"
  return "starting"
}

export function splashMessageKey(phase: SplashPhase) {
  if (phase === "stalled") return "desktop.startup.stalled" as const
  if (phase === "slow") return "desktop.startup.slow" as const
  return "desktop.startup.starting" as const
}
