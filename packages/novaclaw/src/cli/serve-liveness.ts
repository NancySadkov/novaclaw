export * as ServeLiveness from "./serve-liveness"

import { livenessDecision } from "./supervise"

export const PROBE_INTERVAL_MS = 2_000
export const PROBE_TIMEOUT_MS = 3_000

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
