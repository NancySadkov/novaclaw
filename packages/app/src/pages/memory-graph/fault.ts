import { InstanceFetchError } from "@/utils/instance-fetch"

/**
 * What the Memory app says when the graph could not be read.
 *
 * 🔴 The state this replaces. The page caught EVERY `memoryGraph` rejection as `{ nodes: [], edges: [] }`
 * and then rendered "Nothing remembered yet — the graph fills as you chat." A user whose engine is
 * down, whose token expired or whose instance is unreachable was told their cabinet was empty. That is
 * the worst answer this screen can give: it is a confident, wrong statement about the one thing the
 * screen exists to report, and it invites the repair ("just keep chatting") that cannot work.
 *
 * ⚠️ Prose here, structure in `instance-fetch.ts`. This module decides what a PERSON reads; it must
 * never become a second fault vocabulary, so it branches on the structured fault and nothing else.
 */
export interface GraphFault {
  /** One calm sentence. No stack, no status code on its own, no "Error:" prefix. */
  readonly reason: string
  /** Whether Retry can plausibly succeed without the user changing something first. */
  readonly retryable: boolean
}

const capped = (text: string, n = 140) => (text.length > n ? text.slice(0, n - 1) + "…" : text)

export function graphFault(error: unknown): GraphFault {
  if (error instanceof InstanceFetchError) {
    // A 401/403 is an ANSWER, not an outage — the instance is up and the credentials are wrong, so
    // Retry would fail identically forever (`utils/server-health.ts` draws the same line).
    if (error.status === 401 || error.status === 403)
      return { reason: "This instance did not accept the connection's credentials.", retryable: false }
    if (error.status === 404)
      return { reason: "This instance has no memory engine — it may be an older version.", retryable: false }
    if (error.status >= 500)
      return { reason: `The memory engine could not answer: ${capped(error.message)}`, retryable: true }
    return { reason: capped(error.message), retryable: true }
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return { reason: "The memory engine took too long to answer.", retryable: true }
  // A DNS/refused/aborted fetch rejects with the runtime's own TypeError — there was no server, which
  // is a different fact from "the server said no" and the user can act on it (is the instance running?).
  if (error instanceof TypeError) return { reason: "Could not reach this instance.", retryable: true }
  if (error instanceof Error && error.message) return { reason: capped(error.message), retryable: true }
  return { reason: "The memory graph could not be read.", retryable: true }
}
