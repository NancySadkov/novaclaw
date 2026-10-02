export * as MaxUptime from "./max-uptime"

/**
 * How long a supervised server may run before the supervisor rotates it.
 *
 * 🔴 **A LEAK YOU CANNOT FIND IS STILL A LEAK, AND ROTATION BOUNDS ITS BLAST RADIUS.** The product
 * deliberately runs long-lived agents, but a process that grows without bound eventually starves the
 * host — and the measured 2026-10 boots showed exactly that shape (session workers past their limit,
 * paging, a stalled connection). A periodic restart is the coarsest possible guard and it is a real
 * one: it returns committed memory to the OS on a known cadence rather than trusting a fix that may
 * not exist. It is not a substitute for finding the leak; it is what keeps the instance usable while
 * that hunt is open.
 *
 * 24 hours is the default because it is comfortably longer than any single unattended task the
 * product encourages, so the rotation lands in a quiet moment far more often than it interrupts work.
 *
 * ⚠️ The parser lives in `core` because THREE owners need the same answer — the serving supervisor,
 * the desktop launch CLI, and the desktop's dev watchdog — and a second copy is how the three start
 * disagreeing about what `24h` means.
 */
export const DEFAULT_MAX_UPTIME_MS = 24 * 60 * 60 * 1_000

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
}

/**
 * Parse `--max-uptime`.
 *
 * Accepts `24h`, `90m`, `30s`, `7d`, `1500ms`, or a bare integer meaning MILLISECONDS. A bare number
 * is milliseconds rather than hours because the underlying quantity is a duration in ms and a unit
 * the caller did not write is a unit nobody can read back. `off`/`0` disables rotation. Throws with a
 * legible message on anything else — a rotation bound that silently became `NaN`/`undefined` would
 * disable the guard.
 */
export function parseMaxUptime(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_UPTIME_MS
  const text = String(value).trim().toLowerCase()
  if (text === "" || text === "off" || text === "0") return 0
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text)
  if (!match) throw new Error(`--max-uptime must look like 24h, 90m, 30s, 7d or 1500ms (got "${value}")`)
  const amount = Number(match[1])
  const unit = UNITS[match[2] ?? "ms"]!
  const ms = Math.round(amount * unit)
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`--max-uptime must be a positive duration (got "${value}")`)
  return ms
}

/** A rotation is due once the child has been alive this long. `0` disables rotation. */
export function shouldRotate(input: {
  readonly startedAt: number
  readonly now: number
  readonly maxUptimeMs: number
}): boolean {
  if (input.maxUptimeMs <= 0) return false
  return input.now - input.startedAt >= input.maxUptimeMs
}
