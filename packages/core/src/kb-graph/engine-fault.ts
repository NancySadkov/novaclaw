export * as EngineFault from "./engine-fault"

/**
 * Is this engine error FATAL to the WASM module, or merely a failed statement?
 *
 * 🔴 **The distinction the store did not make, and what it cost.** `persist()` caught every
 * `CHECKPOINT` failure, logged "keeping the prior snapshot generation", left `dirty` set and
 * returned — correct for a *transient* failure, which is the case its comment measured. But an
 * emscripten `Aborted()` kills the module **permanently**: `touch()` re-armed the debounce and
 * retried against a corpse, and `close()` awaited a `serialize()` that could never settle.
 *
 * Measured 2026-08-26: a build sat wedged for ~30 minutes at **0.1% CPU, commit charge frozen to the
 * byte, zero sockets** — no crash, no message, no progress. An unnoticed hang is worse than a crash,
 * because a crash at least reports.
 *
 * ⚠️ **Matched on the message because that is all emscripten gives us.** A module that aborts does not
 * surface a typed error, so the signatures below are quoted from real logs rather than invented. Any
 * message that does NOT match stays transient, which keeps the existing retry behaviour for the case
 * it was built for — a new fatal signature shows up as a hang and gets added here with its log line.
 */
const FATAL: readonly RegExp[] = [
  /** `Aborted(Assertion failed: … "pthread mutex deadlock detected" …)` — the module is finished. */
  /\bAborted\(/i,
  /** A trap inside the module; the heap is no longer trustworthy even if a later call returns. */
  /\bOut of bounds memory access\b/i,
  /\bunreachable\b.*\bexecuted\b/i,
  /** emscripten's own words when the runtime has already exited. */
  /\bruntime is not (?:initialized|ready)\b/i,
  /\bmemory access out of bounds\b/i,
]

export function isFatal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return FATAL.some((pattern) => pattern.test(message))
}

/**
 * What a caller is told once the module is dead.
 *
 * ⚠️ It names the ORIGINAL fault, not the current call. Reporting "engine closed" for every later
 * operation is how a root cause gets lost: the first message is the one that explains the rest, and
 * by the time a user notices, the abort is thousands of lines back in a log they do not have.
 */
export function deadMessage(original: string): string {
  return (
    `kb-memory: the graph engine died and cannot be used again in this process — ${original}. ` +
    `The last VERIFIED snapshot generation is retained; reopening the store restores it.`
  )
}
