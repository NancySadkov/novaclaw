/**
 * What a failed request SAYS to the person who triggered it.
 *
 * Owner, 2026-09-03: *"`Failed to fetch (+2 more)` is also extremely obtuse … it tells the user
 * nothing. What did NovaClaw try to fetch? From where? Why could it have failed? What is the user
 * supposed to do now?"*
 *
 * Four questions, and a bare `String(error)` answers none of them. `TypeError: Failed to fetch` is
 * the BROWSER's words for "the request did not complete", written for whoever wrote the fetch call —
 * and it is what a caller gets by default, because passing the error straight through is the shortest
 * thing to type. AGENTS.md: the UI degrades and recovers, it does not hand the user a stack trace,
 * and principle 12 says a control must never require a value the user has no way to know. An error
 * they cannot act on is the same defect facing the other way.
 *
 * So a failure is described by three things the CALLER knows and the error does not:
 *   · the OPERATION that was attempted, in the user's words ("start a chat with Daedalus");
 *   · WHERE it was attempted (which instance) — a remote instance is the common case and
 *     "unreachable" means something different there than on this machine;
 *   · what the user can DO, which is usually the only part they need.
 *
 * ⚠️ The technical text is kept, never discarded — it moves BEHIND the sentence rather than being
 * the sentence. The same rule the error page follows: a frightened reader gets a human line first,
 * and the detail stays reachable for whoever wants it.
 */

/** What the transport actually did, as far as anything on this side can tell. */
export type FailureKind =
  /** The request never completed: DNS, TLS, a refused connection, a dropped Wi-Fi link, a stopped instance. */
  | "unreachable"
  /** The instance answered and said no. Credentials, not connectivity — waiting will not fix it. */
  | "rejected"
  /** The instance answered with a fault of its own. */
  | "faulted"

/**
 * Classify without pretending to more certainty than the evidence gives.
 *
 * ⚠️ `TypeError: Failed to fetch` is the one that matters here, and it is deliberately ambiguous in
 * the browser: the same text covers a refused connection, a DNS miss, a CORS refusal and an aborted
 * request. So it maps to `unreachable`, which is the reading that leads the user somewhere useful
 * (is it running? is the address right?) rather than to a credentials check that was never the problem.
 */
export const classifyFailure = (error: unknown): FailureKind => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (/\b(401|403|unauthor|forbidden|invalid (?:password|credential|token))\b/i.test(text)) return "rejected"
  if (/failed to fetch|networkerror|load failed|econnrefused|enotfound|etimedout|abort/i.test(text))
    return "unreachable"
  return "faulted"
}

export interface FailureCopy {
  /** One line naming the operation and what happened. */
  readonly headline: string
  /** What to do next. Absent when there is genuinely nothing to suggest. */
  readonly remedy?: string
  /** The original text, for the disclosure. Never the headline. */
  readonly detail: string
}

export interface FailureContext {
  /** The operation in the user's words, lowercase, no trailing period: "start a chat with Daedalus". */
  readonly operation: string
  /** The instance this was aimed at, as the user names it. Omitted for a local-only action. */
  readonly target?: string
}

/**
 * Turn a caught error into something a person can act on.
 *
 * Deliberately NOT translated through `language.t` yet: the sentence is assembled from an operation
 * string the caller supplies, and threading a key plus interpolation through every call site is a
 * second change. The copy lives here so it is ONE place to translate when that happens, rather than
 * forty `String(error)` sites to find. ⚠️ That is a stated shortcut, not an oversight.
 */
export const describeFailure = (error: unknown, context: FailureContext): FailureCopy => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const at = context.target ? ` on ${context.target}` : ""
  switch (classifyFailure(error)) {
    case "unreachable":
      return {
        headline: `Could not ${context.operation}${at} — the instance did not answer.`,
        remedy: context.target
          ? `Check that ${context.target} is running and reachable, then try again.`
          : "Check that the instance is running, then try again.",
        detail,
      }
    case "rejected":
      return {
        headline: `Could not ${context.operation}${at} — the instance refused the request.`,
        remedy: "This is a credentials problem, not a connection one. Check the server password in Settings.",
        detail,
      }
    case "faulted":
      return {
        headline: `Could not ${context.operation}${at}.`,
        detail,
      }
  }
}
