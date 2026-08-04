import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigProvider } from "../../config/provider"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import {
  LLMError,
  AuthenticationReason,
  InvalidRequestReason,
  InvalidProviderOutputReason,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
} from "@novaclaw/llm"
import {
  DEFAULT_PROVIDER_ATTEMPTS,
  MAX_PROVIDER_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  isTransientProviderFailure,
  isRetryableBeforeOutput,
  isBrokenResponse,
  maxAttempts,
  retryDelayMs,
  statusCode,
  statusMessage,
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
  test("InvalidProviderOutput retries only at the pre-output boundary", () => {
    const error = llmError(new InvalidProviderOutputReason({ message: "truncated SSE" }))
    expect(isTransientProviderFailure(error)).toBe(false)
    expect(isRetryableBeforeOutput(error)).toBe(true)
    expect(isBrokenResponse(error)).toBe(true)
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

describe("visible retry status", () => {
  test("names the fault class without exposing transport noise", () => {
    expect(statusMessage(llmError(new TransportReason({ message: "fetch failed" })))).toBe(
      "Connection to the model server was lost — retrying…",
    )
    expect(statusMessage(llmError(new ProviderInternalReason({ message: "gateway", status: 524 })))).toBe(
      "The model server had a temporary problem — retrying…",
    )
    expect(statusMessage(llmError(new RateLimitReason({ message: "slow down" })))).toContain("asked NovaClaw to wait")
  })

  test("keeps the provider's HTTP status as structure", () => {
    expect(statusCode(llmError(new ProviderInternalReason({ message: "gateway", status: 524 })))).toBe(524)
    expect(statusCode(llmError(new TransportReason({ message: "timeout" })))).toBeUndefined()
  })
})

// `retryErrorPayload` was tested here until 2026-07-29. It existed only to build the payload of the
// `session.next.retried` event, and both went when the event's last dark consumer was removed — nothing
// rendered a retry, so nothing needed its status code. Do not restore this block without a surface.

describe("cap", () => {
  test("defaults to three and clamps per-model settings to 1–10", () => {
    expect(maxAttempts(undefined)).toBe(DEFAULT_PROVIDER_ATTEMPTS)
    expect(maxAttempts(Number.NaN)).toBe(DEFAULT_PROVIDER_ATTEMPTS)
    expect(maxAttempts(0)).toBe(1)
    expect(maxAttempts(5.9)).toBe(5)
    expect(maxAttempts(99)).toBe(MAX_PROVIDER_ATTEMPTS)
  })

  test("the per-model setting survives config decode and new catalog models default to three", () => {
    const decoded = Schema.decodeUnknownSync(ConfigProvider.Info)({
      models: { deepseek: { retry: { attempts: 5 } } },
    })
    expect(decoded.models?.deepseek?.retry?.attempts).toBe(5)
    expect(ModelV2.Info.empty(ProviderV2.ID.make("provider"), ModelV2.ID.make("model")).retry?.attempts).toBe(3)
  })
})
