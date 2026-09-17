/**
 * How long a running command or worker has been alive, in the compact form a list row has room for.
 *
 * Deliberately unit-suffixed and language-neutral, matching the transcript's own `seconds`
 * formatter: "3s", "3m 12s", "3h 7m". Hours drop the seconds because a command that has survived
 * four hours does not need a per-second figure, and re-rendering one would only cost frames.
 *
 * Clamped at zero so a clock that steps backwards reports `0s` rather than a negative duration.
 */
export function formatElapsed(startedAt: number, now: number = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
