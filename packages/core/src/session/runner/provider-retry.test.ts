import { describe, expect, test } from "bun:test"
import {
  LLMError,
  AuthenticationReason,
  InvalidRequestReason,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
} from "@novaclaw/llm"
import {
  MAX_PROVIDER_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  isTransientProviderFailure,
  retryDelayMs,
  retryErrorPayload,
} from "./provider-retry"

const llmError = (reason: LLMError["reason"]) => new LLMError({ module: "test", method: "stream", reason })

describe("isTransientProviderFailure (1D taxonomy)", () => {
  test("Transport (connection refused — the local-server-down case) IS transient here", () =>
    expect(
      isTransientProviderFailure(llmError(new TransportReason({ message: "fetch failed", kind: "connection" }))),
    ).toBe(true))
  test("ProviderInternal 5xx is transient", () =>
    expect(isTransientProviderFailure(llmError(new ProviderInternalReason({ message: "boom", status: 503 })))).toBe(
      true,
    ))
  test("RateLimit 429 is transient", () =>
    expect(isTransientProviderFailure(llmError(new RateLimitReason({ message: "slow down" })))).toBe(true))
  test("Authentication is FATAL — retrying cannot fix it", () =>
    expect(
      isTransientProviderFailure(llmError(new AuthenticationReason({ message: "bad key", kind: "invalid" }))),
    ).toBe(false))
  test("InvalidRequest is FATAL (context overflow has its own recovery)", () =>
    expect(isTransientProviderFailure(llmError(new InvalidRequestReason({ message: "too long" })))).toBe(false))
  test("QuotaExceeded is FATAL", () =>
    expect(isTransientProviderFailure(llmError(new QuotaExceededReason({ message: "quota" })))).toBe(false))
  test("a non-LLMError is never retried", () => {
    expect(isTransientProviderFailure(new Error("random"))).toBe(false)
    expect(isTransientProviderFailure(undefined)).toBe(false)
  })
  test("OFF-A: Transport with kind InvalidUrlError (offline-policy block) is FATAL", () =>
    expect(
      isTransientProviderFailure(
        llmError(new TransportReason({ message: "HTTP transport failed: InvalidUrlError", kind: "InvalidUrlError" })),
      ),
    ).toBe(false))
})

describe("retryDelayMs", () => {
  test("escalating backoff per attempt", () => {
    expect(retryDelayMs(1)).toBe(1_000)
    expect(retryDelayMs(2)).toBe(3_000)
    expect(retryDelayMs(3)).toBe(9_000)
    expect(retryDelayMs(99)).toBe(9_000)
  })
  test("provider retry-after wins when present", () => expect(retryDelayMs(1, 2_500)).toBe(2_500))
  test("retry-after is capped so a hostile header cannot stall the turn", () =>
    expect(retryDelayMs(1, 10 * 60 * 1000)).toBe(MAX_RETRY_DELAY_MS))
  test("nonsense retry-after falls back to backoff", () => {
    expect(retryDelayMs(2, Number.NaN)).toBe(3_000)
    expect(retryDelayMs(2, -5)).toBe(3_000)
  })
})

describe("retryErrorPayload", () => {
  test("carries the message + status for a 5xx", () => {
    const payload = retryErrorPayload(llmError(new ProviderInternalReason({ message: "upstream died", status: 502 })))
    expect(payload.message).toContain("upstream died")
    expect(payload.statusCode).toBe(502)
    expect(payload.isRetryable).toBe(true)
  })
  test("omits status when there is none (transport)", () => {
    const payload = retryErrorPayload(llmError(new TransportReason({ message: "fetch failed" })))
    expect(payload.statusCode).toBeUndefined()
  })
})

describe("cap", () => {
  test("the per-turn attempt cap is small — a dead endpoint fails in seconds", () =>
    expect(MAX_PROVIDER_ATTEMPTS).toBeLessThanOrEqual(3))
})
