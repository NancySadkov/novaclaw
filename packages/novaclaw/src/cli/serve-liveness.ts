export * as ServeLiveness from "./serve-liveness"

import { livenessDecision } from "./supervise"

export const PROBE_INTERVAL_MS = 2_000
export const PROBE_TIMEOUT_MS = 3_000

/**
 * How long the supervisor waits for the child to flush before killing it anyway.
 *
 * Sized against the child's own `SHUTDOWN_DEADLINE` rather than guessed: the parent must outwait the
 * child, or it kills a settle that was about to succeed and the wait bought nothing. Kept short
 * enough that a wedged child does not turn Ctrl+C into a hang — an exit that takes noticeably longer
 * than advertised is the reason people reach for `kill -9`.
 */
export const STOP_TIMEOUT_MS = 8_000

/** Turn the child's public listen announcement into a loopback health URL for its parent. */
export function probeURLFromListenLine(line: string): URL | undefined {
  const prefix = "novaclaw server listening on "
  if (!line.startsWith(prefix)) return
  try {
    const url = new URL(line.slice(prefix.length).trim())
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]" || url.hostname === "::") url.hostname = "127.0.0.1"
    url.pathname = "/global/health"
    url.search = ""
    url.hash = ""
    return url
  } catch {
    return
  }
}

export async function probe(url: URL, password?: string): Promise<boolean> {
  const headers = new Headers()
  if (password) headers.set("authorization", `Basic ${Buffer.from(`novaclaw:${password}`).toString("base64")}`)
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Ask the child to release its instances before we kill it.
 *
 * 🔴 **Why this exists at all.** The supervisor's only way to stop its child was a tree-kill, and on
 * Windows that is `TerminateProcess` — the child's SIGINT/SIGTERM handlers, and therefore its whole
 * `Shutdown.settleAll`, never run. Measured 2026-08-12: a bare server sent `Stop-Process` died with
 * nothing logged. So every supervised stop silently discarded whatever was mid-flush, and instance
 * disposal is precisely the half holding unflushed session state.
 *
 * Asking over HTTP sidesteps signals entirely, which is what makes it work on Windows.
 *
 * ⚠️ This deliberately does NOT stop the child's HTTP server or exit it — no such endpoint exists,
 * and adding one would mean shipping a remote-triggerable shutdown, a security surface this does not
 * need. `/global/dispose` already exists and already runs the SAME `store.disposeAll()` the child's
 * own shutdown path calls. The kill still follows; this only makes it a kill of a process that has
 * already let go of its state.
 *
 * Returns whether the child confirmed. Never throws: a failure here must not stop the kill.
 */
export async function requestStop(healthURL: URL, password?: string): Promise<boolean> {
  const url = new URL(healthURL)
  url.pathname = "/global/dispose"
  const headers = new Headers()
  if (password) headers.set("authorization", `Basic ${Buffer.from(`novaclaw:${password}`).toString("base64")}`)
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function monitor(input: {
  readonly signal: AbortSignal
  readonly check: () => Promise<boolean>
  readonly wait?: (signal: AbortSignal) => Promise<void>
  readonly onUnresponsive: (failures: number) => void
}): Promise<void> {
  let failures = 0
  const wait = input.wait ?? waitForProbe
  while (!input.signal.aborted) {
    await wait(input.signal)
    if (input.signal.aborted) return
    const decision = livenessDecision(failures, await input.check())
    if (input.signal.aborted) return
    failures = decision.failures
    if (decision.action === "continue") continue
    input.onUnresponsive(failures)
    return
  }
}

function waitForProbe(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, PROBE_INTERVAL_MS)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}
