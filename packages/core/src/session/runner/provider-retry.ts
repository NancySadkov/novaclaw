// 1D — the forgiving loop's provider-failure taxonomy. For a LOCAL model, "server
// down / restarting" is the COMMON failure, and it used to kill the turn outright.
// The policy is deliberately narrow (this is the critical error path):
//
//   - Retry only failures that are TRANSIENT by class: Transport (connection
//     refused/reset/timeout — the local-vLLM-restarting case), ProviderInternal
//     (5xx), and RateLimit (429, honoring retry-after).
//   - InvalidProviderOutput is retryable only before useful output. Once output exists,
//     the runner accepts the partial turn as broken and starts a continuation request.
//   - A bounded, per-model attempt cap — a DEAD endpoint must fail after seconds,
//     not loop forever. The configured value is clamped here.
//   - The runner additionally only replays attempts that failed before durable assistant
//     output, so a retry can never duplicate partially-streamed text or tool actions.
//
// Pure + dependency-light so the taxonomy is unit-tested without a provider.

import { LLMError } from "@novaclaw/llm"

/** Total provider attempts per turn (1 original + 2 retries). */
export const DEFAULT_PROVIDER_ATTEMPTS = 3
export const MAX_PROVIDER_ATTEMPTS = 10

/** Resolve a user-authored attempt count without allowing zero, infinity, or retry storms. */
export function maxAttempts(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured)) return DEFAULT_PROVIDER_ATTEMPTS
  return Math.min(MAX_PROVIDER_ATTEMPTS, Math.max(1, Math.floor(configured)))
}

/** Ceiling for a provider-supplied retry-after, so a hostile header can't stall a turn. */
export const MAX_RETRY_DELAY_MS = 30_000

const BACKOFF_MS = [1_000, 3_000, 9_000]

/**
 * True when retrying the SAME request can plausibly succeed. `Transport` is retryable
 * here even though the schema-level taxonomy says otherwise: at this level a transport
 * failure usually means the local server is down or restarting, and the attempt cap
 * bounds the a-dead-endpoint case that motivated the schema's `false`.
 */
export function isTransientProviderFailure(error: unknown): error is LLMError {
  if (!(error instanceof LLMError)) return false
  if (error.reason._tag === "Transport") {
    // A request that never left the machine is DETERMINISTIC — retrying cannot succeed.
    // ⚠️ The offline-policy block no longer arrives here: it has its own `OfflineBlocked` reason
    // (2026-07-30), whose `retryable` getter is `false`, so the answer comes from the type rather
    // than from this string. What still reaches this line is the platform's own malformed-URL
    // `InvalidUrlError`, which is equally deterministic — so the check stays, with a narrower job.
    if ((error.reason as { kind?: string }).kind === "InvalidUrlError") return false
    return true
  }
  return error.retryable
}

/** A malformed/truncated reply can be replayed only while it has produced no durable assistant output. */
export function isRetryableBeforeOutput(error: unknown): error is LLMError {
  return (
    isTransientProviderFailure(error) || (error instanceof LLMError && error.reason._tag === "InvalidProviderOutput")
  )
}

/** A malformed stream tail is non-fatal once useful output has already been persisted. */
export function isBrokenResponse(error: unknown): error is LLMError {
  return error instanceof LLMError && error.reason._tag === "InvalidProviderOutput"
}

/** Delay before retry `attempt` (1-based: the delay after the attempt-th failure). */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0)
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS)
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
}

/** Calm, user-facing status while the bounded automatic retry sleeps. */
export function statusMessage(error: LLMError): string {
  if (error.reason._tag === "RateLimit") return "The model provider asked NovaClaw to wait — retrying…"
  if (error.reason._tag === "ProviderInternal") return "The model server had a temporary problem — retrying…"
  if (error.reason._tag === "InvalidProviderOutput") return "The model sent an incomplete reply — reconnecting safely…"
  return "Connection to the model server was lost — retrying…"
}

/** Preserve the HTTP verdict for the transcript's precise explanation and diagnostics disclosure. */
export function statusCode(error: LLMError): number | undefined {
  if ("status" in error.reason && typeof error.reason.status === "number") return error.reason.status
  return "http" in error.reason ? error.reason.http?.response?.status : undefined
}

// ⚠️ `retryErrorPayload` lived here and was deleted 2026-07-29 with the `session.next.retried` event it
// built the payload for — it had no other caller. The runner now logs the failed attempt instead
// (`runner/llm.ts`), so the status-code extraction it did is no longer needed by anything.

export * as ProviderRetry from "./provider-retry"
