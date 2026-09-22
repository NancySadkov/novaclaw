import { describe, expect, test } from "bun:test"
import {
  LLMError,
  QuotaExceededReason,
  RateLimitReason,
} from "./schema"
import {
  classify,
  contextLimitFrom,
  imageLimitFrom,
  isContextOverflow,
  isMediaLimit,
  isQuotaBody,
  isQuotaExceededFailure,
  isReasoningEffortUnsupported,
  promptTokensFrom,
  reasoningEffortFloorFrom,
} from "./provider-error"

/**
 * **A 4xx body that names its own cause is evidence about the ENDPOINT** — the principle
 * `provider-capability.ts` already records, applied to the second condition that satisfies it.
 *
 * 🔴 Measured 2026-08-19 (`notes/reports/vision-on-disk-2026-08-19.md`): the first live run in which
 * a model actually read a folder of images died on the fourth with `At most 3 image(s) may be
 * provided in one prompt. (parameter=image)`. Untreated it is a DEAD-END rather than a hiccup —
 * every later turn re-lowers the same history and re-fails identically.
 */

/** The exact body vLLM returned, kept verbatim so a wording change here is a deliberate act. */
const MEASURED = "At most 3 image(s) may be provided in one prompt. (parameter=image)"

describe("image-cap refusals", () => {
  test("reads the number out of the message we actually measured", () => {
    expect(imageLimitFrom(MEASURED)).toBe(3)
    expect(isMediaLimit(MEASURED)).toBe(true)
    expect(classify(MEASURED)).toBe("media-limit")
  })

  test("reads other phrasings, because the endpoint is not ours to standardise", () => {
    expect(imageLimitFrom("At most 10 images may be provided in one prompt")).toBe(10)
    expect(imageLimitFrom("Too many images in request; maximum of 8 allowed")).toBe(8)
    expect(imageLimitFrom("image count of 12 exceeds the maximum of 5")).toBe(5)
  })

  // Detected-but-unreadable is a real answer, not a miss: an endpoint can name images as the
  // offending parameter without stating a count, and sending none is the only safe reading.
  test("a cap with no number reads as 0, which is still actionable", () => {
    expect(imageLimitFrom("Too many images in this request")).toBe(0)
    expect(imageLimitFrom("image limit exceeded")).toBe(0)
  })

  test("ordinary text is NOT a cap — the third state stays distinguishable from zero", () => {
    expect(imageLimitFrom("Internal server error")).toBeUndefined()
    expect(imageLimitFrom("invalid api key")).toBeUndefined()
    // 🔴 The one that would be silently wrong: a message merely CONTAINING the word, with no
    // refusal in it. Reading this as a cap of 0 would strip every image from a healthy session.
    expect(imageLimitFrom("generated an image successfully")).toBeUndefined()
    expect(imageLimitFrom("imagery processing complete")).toBeUndefined()
  })
})

describe("classify — one place, so three protocol sites cannot drift", () => {
  test("a context overflow still classifies as one", () => {
    expect(classify("This model's maximum context length is 8192 tokens")).toBe("context-overflow")
    expect(isContextOverflow("prompt is too long")).toBe(true)
  })

  test("unrelated failures classify as nothing", () => {
    expect(classify("502 Bad Gateway")).toBeUndefined()
  })

  /**
   * ⚠️ **The ORDER is the decision, not an implementation detail.** An endpoint refusing a request
   * that carries several large images can word it as a length problem. Classifying that as an
   * overflow triggers COMPACTION — which summarises text and removes not one image — so the turn
   * burns a compaction and then fails again identically, with the history now shorter and the same
   * images still in it. The recovery has to fit the fault.
   */
  test("a message that names BOTH is a media limit, because compaction cannot fix it", () => {
    expect(classify("At most 3 image(s) may be provided; prompt is too long")).toBe("media-limit")
  })
})

/**
 * **The effort enum is drawn tighter than the provider-neutral one, and the endpoint says so.**
 *
 * `ProviderDispatch.withoutReasoning` asks for "no thinking" with `"none"`; every other endpoint
 * accepts it. A gateway whose upstream starts at `minimal` refuses the whole request, and untreated
 * that is a DEAD-END: every compaction and every zero-budget turn re-fails identically.
 */
describe("reasoning-effort refusals", () => {
  /** The exact body the gateway returned for `muse-spark-1.3-contributor`, 2026-09-22. */
  const MEASURED =
    'Provider request failed with HTTP 400: {"model":"muse-spark-1.3-contributor","error":{"param":"reasoning.effort","type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] reasoning_effort \'none\' is not supported for model \'muse-spark-1.3-contributor\'. Supported values: [minimal, low, medium, high, xhigh, max]"}}'

  test("reads the floor out of the message we actually measured", () => {
    expect(isReasoningEffortUnsupported(MEASURED)).toBe(true)
    expect(reasoningEffortFloorFrom(MEASURED)).toBe("minimal")
    expect(classify(MEASURED)).toBe("reasoning-effort")
  })

  test("reads the other phrasings, because the endpoint is not ours to standardise", () => {
    // The OpenAI Responses shape: no brackets, quoted values after "Supported values are".
    expect(
      reasoningEffortFloorFrom(
        "param reasoning.effort: Unsupported value: 'none' is not supported. Supported values are: 'low', 'medium', 'high'.",
      ),
    ).toBe("low")
    // A refusal whose list we cannot read still yields the adjacent lower value.
    expect(reasoningEffortFloorFrom("reasoning_effort: 'none' is not supported here")).toBe("minimal")
  })

  test("a refusal is not a floor when nothing names the parameter", () => {
    expect(isReasoningEffortUnsupported("502 Bad Gateway")).toBe(false)
    expect(reasoningEffortFloorFrom("502 Bad Gateway")).toBeUndefined()
    expect(classify("502 Bad Gateway")).toBeUndefined()
  })

  test("naming the parameter without refusing it is not a refusal", () => {
    expect(isReasoningEffortUnsupported("reasoning_effort was accepted")).toBe(false)
    expect(reasoningEffortFloorFrom("reasoning_effort was accepted")).toBeUndefined()
  })
})

/**
 * **The refusing body is a MEASUREMENT of the exact request**, and it is the only free one in the
 * system: every other prompt count arrives from a usage report after a call that succeeded.
 */
describe("quota bodies — a throttled account is endpoint health, not a malformed request", () => {
  test("names the account states a gateway actually sends", () => {
    expect(isQuotaBody("Go usage limit exceeded.")).toBe(true)
    expect(isQuotaBody("insufficient_quota")).toBe(true)
    expect(isQuotaBody("Quota exceeded for this month")).toBe(true)
    expect(isQuotaBody("insufficient credits: balance 0")).toBe(true)
  })

  test("refuses the neighbours — a bare limit or a window is not an account", () => {
    expect(isQuotaBody("image limit exceeded")).toBe(false)
    expect(isQuotaBody("This model's maximum context length is 8192 tokens")).toBe(false)
    expect(isQuotaBody("502 Bad Gateway")).toBe(false)
    expect(isQuotaBody("invalid api key")).toBe(false)
  })

  test("a quota refusal reads as a quota failure from every channel that carries it", () => {
    const thrown = new LLMError({
      module: "test",
      method: "stream",
      reason: new QuotaExceededReason({ message: "Go usage limit exceeded." }),
    })
    expect(isQuotaExceededFailure(thrown)).toBe(true)
    expect(isQuotaExceededFailure("Go usage limit exceeded.")).toBe(true)
    const rateLimited = new LLMError({
      module: "test",
      method: "stream",
      reason: new RateLimitReason({ message: "slow down" }),
    })
    expect(isQuotaExceededFailure(rateLimited)).toBe(false)
    expect(isQuotaExceededFailure(undefined)).toBe(false)
  })
})
/**
 * **The refusing body is a MEASUREMENT of the exact request**, and it is the only free one in the
 * system: every other prompt count arrives from a usage report after a call that succeeded.
 */
describe("the prompt count in a context-overflow body", () => {
  /** The exact body from `ses_daedalus`, 2026-09-14 21:22 — kept verbatim. */
  const MEASURED =
    'Provider request failed with HTTP 400: {"error":{"message":"This model\'s maximum context length is 262144 tokens. However, you requested 16384 output tokens and your prompt contains at least 245761 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=245761)","type":"BadRequestError","param":"input_tokens","code":400}}'

  test("reads both numbers out of the message we actually measured", () => {
    expect(promptTokensFrom(MEASURED)).toBe(245_761)
    expect(contextLimitFrom(MEASURED)).toBe(262_144)
    expect(classify(MEASURED)).toBe("context-overflow")
  })

  test("reads the other phrasings, because the endpoint is not ours to standardise", () => {
    expect(promptTokensFrom("This model's maximum prompt length is 4096 tokens")).toBeUndefined()
    expect(promptTokensFrom("prompt contains at least 90000 input tokens")).toBe(90_000)
    expect(promptTokensFrom("your input is too long: 123456 input tokens")).toBe(123_456)
    expect(contextLimitFrom("context length is only 8192 tokens")).toBe(8_192)
    expect(contextLimitFrom("input exceeds the limit of 131072")).toBe(131_072)
  })

  /**
   * ⚠️ **The negative case is the load-bearing one**, exactly as it is for the image cap: the last
   * pattern is loose by design, so an unreadable body must read as "no measurement" rather than as
   * a number scraped out of prose. The classifier is what keeps the loose pattern safe — this test
   * is the statement of that contract.
   */
  test("a body with no count reads as no measurement", () => {
    expect(promptTokensFrom("prompt is too long")).toBeUndefined()
    expect(promptTokensFrom("502 Bad Gateway")).toBeUndefined()
    expect(contextLimitFrom("prompt is too long")).toBeUndefined()
  })

  test("a healthy reply that merely mentions input tokens is not a measurement", () => {
    // Reading this as a prompt count would anchor the next turn's estimator to a number about
    // nothing. It is only ever called behind `classify(...) === "context-overflow"`.
    expect(classify("the response used 1200 input tokens")).toBeUndefined()
  })
})
