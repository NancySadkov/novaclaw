import { Effect, Stream } from "effect"
import { Offline } from "@novaclaw/core/offline"
import { readBoundedText } from "@novaclaw/schema/bounded-stream"

/**
 * The first-party maintenance broker: the instance fetches the changelog, the UI asks the instance.
 *
 * 🔴 NC-SEC-015 — the renderer used to fetch `novaclaw.app/changelog.json` itself, and it CANNOT
 * consult airgap policy: the policy lives on the instance and the renderer never reaches the wire.
 * So an instance the user had airgapped announced, once per version change, that its user had opened
 * the app — from whatever machine the UI happened to be running on.
 *
 * ⚠️ A broker rather than a client-side check, and the vision decides it: the instance owns its
 * network policy, and the UI is a thin client that may be pointed at ANY instance. A check in the
 * renderer would be a second copy of a policy that already has an owner, and it would evaluate that
 * policy on the wrong machine.
 *
 * ⚠️ It PROXIES rather than reinterpreting. The renderer's failure model distinguishes an HTTP
 * answer from a network silence from a malformed body, each with a different consequence (a 404
 * marks the version seen because it is an ANSWER; a network error does not, because it is not).
 * Rewriting upstream's reply into a verdict here would collapse distinctions the caller is built to
 * tell apart.
 */

/** How long the instance will wait on the upstream host before calling it unreachable. */
export const CHANGELOG_TIMEOUT_MS = 10_000

/**
 * The cap on what the upstream may return.
 *
 * ⚠️ Enforced while READING, not after. The body is attacker-influenced in the sense that matters
 * here — a host that is not this instance decides its size — and buffering first to measure it is
 * how a cap becomes a display limit (NC-SEC-006, same mistake, different reader).
 */
export const CHANGELOG_MAX_BYTES = 1024 * 1024

export const CHANGELOG_URL = "https://novaclaw.app/changelog.json"

export type BrokerResult =
  /** The instance's own policy refused. Not a fault: the user asked for this. */
  | { readonly kind: "refused"; readonly message: string }
  /** Upstream answered. `status` and `body` are ITS answer, passed through untouched. */
  | { readonly kind: "answered"; readonly status: number; readonly body: string }
  /** No answer from upstream — offline, DNS, TLS, timeout, host down. */
  | { readonly kind: "unreachable"; readonly detail: string }

/**
 * Ask the upstream host, under this instance's policy.
 *
 * `fetcher` is injected so the whole decision can be exercised without a network — the refusal path
 * above all, which must be provable to make NO request at all rather than to discard one.
 */
export const fetchChangelog = (
  policy: Offline.Policy,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  url: string = CHANGELOG_URL,
): Effect.Effect<BrokerResult> =>
  Effect.gen(function* () {
    const verdict = Offline.checkUrl(url, policy)
    // ⚠️ Before any request is constructed. A refusal that happened after the fetch would still have
    // told `novaclaw.app` that this instance is running, which is the entire thing being fixed.
    if (!verdict.allowed) return { kind: "refused", message: verdict.message } as const

    const response = yield* Effect.tryPromise({
      try: (signal) => fetcher(url, { signal, headers: { Accept: "application/json" } }),
      catch: (cause) => cause,
    }).pipe(
      Effect.timeout(CHANGELOG_TIMEOUT_MS),
      Effect.catchCause((cause) => Effect.succeed({ unreachable: describe(cause) } as const)),
    )
    if ("unreachable" in response) return { kind: "unreachable", detail: response.unreachable } as const

    // ⚠️ Bounded while READING. `readBoundedText` stops at the cap instead of measuring a completed
    // buffer, which is the difference between a limit and a display limit (NC-SEC-006).
    const upstream = response.body
    if (upstream === null) return { kind: "answered", status: response.status, body: "" } as const
    const read = yield* readBoundedText(
      Stream.fromReadableStream({ evaluate: () => upstream, onError: (cause) => new Error(describe(cause)) }),
      CHANGELOG_MAX_BYTES,
    ).pipe(Effect.catchCause((cause) => Effect.succeed({ unreachable: describe(cause) } as const)))
    if ("unreachable" in read) return { kind: "unreachable", detail: read.unreachable } as const
    // ⚠️ A truncated body is NOT passed off as an answer. The caller parses this as JSON, and a
    // truncated document either fails to parse (reported as malformed, which is true but names the
    // wrong culprit) or — worse — parses into something shorter than what was sent.
    if (read.truncated)
      return { kind: "unreachable", detail: `upstream body exceeded ${CHANGELOG_MAX_BYTES} bytes` } as const
    return { kind: "answered", status: response.status, body: read.text } as const
  })

/** One sentence, never an object dump: this reaches a log the user may be asked to read. */
function describe(cause: unknown): string {
  const text = String(cause)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
