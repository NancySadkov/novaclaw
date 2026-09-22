import { Schema } from "effect"
import { LLMError, ProviderErrorEvent, ReasoningEfforts, type ReasoningEffort } from "./schema"

const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

/**
 * A per-request IMAGE CAP, and the NUMBER it allows — the second 4xx that is evidence about the
 * endpoint rather than about the request being malformed.
 *
 * 🔴 Measured 2026-08-19 (`notes/reports/vision-on-disk-2026-08-19.md`): the first run in which a
 * model actually read a folder of images died on the fourth with
 * `At most 3 image(s) may be provided in one prompt. (parameter=image)` — vLLM's
 * `--limit-mm-per-prompt`, a sparkrun default. Untreated it is a DEAD-END, not a hiccup: every later
 * turn re-lowers the same history and re-fails identically.
 *
 * ⭐ **The number is in the message, so this does not have to be guessed.** `provider-capability.ts`
 * already records the principle — *"the one place a failure IS evidence: a 4xx whose body names the
 * offending parameter"* — and this is that case exactly.
 *
 * Returns the allowed count, or `undefined` when the message is not an image-cap refusal. A cap we
 * can detect but not read the number from returns `0`: still actionable (send no images) and
 * distinguishable from "not this kind of failure".
 */
const IMAGE_LIMIT_PATTERNS = [
  /at most (\d+) image\(?s?\)? may be provided/i,
  /at most (\d+) image/i,
  /too many images.*?maximum (?:of )?(\d+)/i,
  /image count (?:of )?\d+ exceeds (?:the )?(?:maximum|limit) (?:of )?(\d+)/i,
  /number of images.*?exceeds.*?(\d+)/i,
]
export const imageLimitFrom = (message: string): number | undefined => {
  for (const pattern of IMAGE_LIMIT_PATTERNS) {
    const match = pattern.exec(message)
    if (match) {
      const value = Number(match[1])
      return Number.isFinite(value) && value >= 0 ? value : 0
    }
  }
  // Detected but unreadable: an endpoint that names images as the offending parameter without
  // stating a count. Sending none is the only safe reading, and it is still a real answer.
  // ⚠️ The word boundaries are load-bearing: without them "imagery" and "imagine" match, and a
  // healthy reply mentioning either reads as a cap of 0 — which would strip every image from a
  // working session. They were once written as literal 0x08 bytes by a shell that ate the
  // backslashes; the regex still compiled, the happy path still passed, and only the NEGATIVE
  // case noticed. That is why the negative case is in the test file.
  if (/\bimages?\b/i.test(message) && /(too many|limit|at most|exceed)/i.test(message)) return 0
  return undefined
}

export const isMediaLimit = (message: string) => imageLimitFrom(message) !== undefined

/**
 * The provider's OWN count of the prompt it refused — the third 4xx that is evidence about the
 * request rather than a malformed body, and the same principle as `imageLimitFrom` above: the
 * number is in the message, so it does not have to be guessed.
 *
 * 🔴 **Measured 2026-09-14 (`ses_daedalus`): this is the one place the true token count of an exact
 * request is FREE, and it was thrown away.** The harness estimates every prompt it sends
 * (`Token.estimate`, a heuristic) and only ever learns the truth from a usage report *after* a
 * successful call. A context-overflow 400 is a measurement taken before the call that would have
 * given us one:
 *
 * ```
 * "This model's maximum context length is 262144 tokens. However, you requested 16384 output tokens
 *  and your prompt contains at least 245761 input tokens ... (parameter=input_tokens, value=245761)"
 * ```
 *
 * That session's own estimate for the same request was 281,140 — 14 % HIGH. Recovery then cut 25 %
 * of a number already 14 % wrong, so the retry target was ~8,800 tokens away from what a correct
 * reading would have asked for. **Recovering from an overflow by cutting a fraction of a number we
 * already know is wrong is the defect this closes.**
 *
 * ⚠️ **Only ever call this on a message already classified `context-overflow`.** The last pattern is
 * deliberately loose (a bare `N input tokens`), and a *healthy* message that happens to mention
 * input tokens would match it. The classification is what makes the reading safe, and
 * `provider-error.test.ts` pins both halves of that: the reading, and the fact that it is reached
 * only through the classifier.
 */
const PROMPT_TOKENS_PATTERNS = [
  // vLLM / OpenAI-compatible: `(parameter=input_tokens, value=245761)`.
  /parameter=input_tokens,\s*value=(\d+)/i,
  // OpenAI: "your prompt contains at least 245761 input tokens".
  /contains at least (\d+) input tokens/i,
  // Older/other wordings that name the prompt and then the count.
  /prompt contains at least (\d+)/i,
  // ⚠️ Requires the words "input tokens" together. A bare `(\d+) tokens` also matches
  // "maximum prompt length is 4096 tokens" — a LIMIT, not a count — and reading a window as a
  // prompt size is the one way this helper could make an overflow worse.
  /(?:prompt|input)[^.\n]{0,40}?(\d+) input tokens/i,
]
export const promptTokensFrom = (message: string): number | undefined => {
  for (const pattern of PROMPT_TOKENS_PATTERNS) {
    const match = pattern.exec(message)
    if (match === null) continue
    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * The window the provider says it has, read from the same body.
 *
 * ⭐ Not a replacement for the configured route limit — the configured limit is what the packer and
 * the compactor budget against, and it is what the server was *launched* to honour. This is the
 * number the refusing process actually enforced, which is the useful one when the two disagree:
 * a route that advertises 262,144 while serving 131,072 is exactly the case that produces a
 * "boundary that is not enforced" 400, and the sentence naming it is the only place that is said.
 */
const CONTEXT_LIMIT_PATTERNS = [
  /maximum context length is (\d+) tokens/i,
  /context length is only (\d+) tokens/i,
  /exceeds the limit of (\d+)/i,
  /maximum prompt length is (\d+)/i,
]
export const contextLimitFrom = (message: string): number | undefined => {
  for (const pattern of CONTEXT_LIMIT_PATTERNS) {
    const match = pattern.exec(message)
    if (match === null) continue
    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * The endpoint saying it does not serve this model at all.
 *
 * 🔴 A different KIND of evidence from every other fault here, and that is why it has its own
 * predicate rather than joining `classify`. An overflow or a media cap is evidence about the
 * REQUEST, and the recovery is to send a smaller one. This is evidence about the CATALOG: the model
 * we were told exists does not, so no retry and no smaller request will ever succeed and the only
 * recovery is to run something else.
 *
 * Measured 2026-09-02 on a live instance, where a chat pinned to a model the endpoint had replaced
 * failed identically on every turn: `HTTP 404 {"message":"The model `holo3.1` does not exist."}`.
 *
 * ⚠️ The separator is `[^\n]`, NOT `[^.]` — a model id contains dots, so a dot-excluding gap could
 * never span the very thing being matched. That bug shipped in the first cut of the sibling matcher
 * in `session-error.ts` and was caught by a test rather than by reading it.
 */
const MODEL_MISSING =
  /\bmodel\b[^\n]{0,80}?\b(?:does not exist|not found|unknown|is not available)\b|\bno such model\b/i

export const isModelMissing = (message: string): boolean => MODEL_MISSING.test(message)

/**
 * The endpoint refused a REASONING EFFORT value, and usually names the ones it does accept.
 *
 * 🔴 Measured 2026-09-22 against a hosted gateway serving `muse-spark-1.3-contributor`:
 *
 * ```
 * HTTP 400 {"model":"muse-spark-1.3-contributor","error":{"param":"reasoning.effort",
 *   "type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error]
 *   reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'.
 *   Supported values: [minimal, low, medium, high, xhigh, max]"}}
 * ```
 *
 * `ProviderDispatch.withoutReasoning` sends `"none"` to mean "answer without thinking"; every other
 * endpoint we drive accepts it. On this one the enum starts at `minimal`, so a no-thinking
 * compaction and a zero-budget turn both failed identically and forever.
 *
 * ⚠️ The offending PARAMETER is what makes this safe to detect — a bare `/not supported/` would fire
 * on any refusal. Both the `reasoning_effort` field spelling and the `reasoning.effort` dotted path
 * are matched, because the chat wire names the field and the responses wire names the path.
 */
const REASONING_EFFORT_PARAM = /reasoning[_ .]?effort/i
const REASONING_EFFORT_REFUSAL = /not supported|unsupported|does not support|not valid|unrecognized/i

export const isReasoningEffortUnsupported = (message: string): boolean =>
  REASONING_EFFORT_PARAM.test(message) && REASONING_EFFORT_REFUSAL.test(message)

/**
 * The endpoint's own lower bound, read from the same body.
 *
 * ⭐ The values are IN the message, so the floor does not have to be guessed. First listed value
 * wins: a refusal names its accepted set in ascending order, so the head is the least thinking the
 * endpoint will do — which is the closest thing to "do not think" that it offers.
 *
 * Returns `"minimal"` when the refusal is real but its list is missing or unreadable: the value
 * adjacent to `"none"` is always a legal lower bound, and sending it is strictly better than
 * repeating a refusal. `undefined` means this is not a reasoning-effort refusal at all.
 */
// ⚠️ `\b` before `supported` is load-bearing. Without it the pattern also matches inside
// "Unsupported value: 'none' …", which names the REJECTED value first — so the parser read the
// refusal's own "none" back as the floor and learned nothing. `Unsupported` has no word boundary
// before its `supported`, so the anchor is what keeps the two apart.
const SUPPORTED_VALUES = /\bsupported values?\s*(?:are)?\s*:?\s*\[([^\]]+)\]/i
const SUPPORTED_TRAILING = /\bsupported values?\s*(?:are)?\s*:?\s*(.+)$/i

export const reasoningEffortFloorFrom = (message: string): ReasoningEffort | undefined => {
  if (!isReasoningEffortUnsupported(message)) return undefined
  const listed = SUPPORTED_VALUES.exec(message)?.[1] ?? SUPPORTED_TRAILING.exec(message)?.[1]
  if (listed !== undefined) {
    for (const token of listed.match(/[a-z]+/gi) ?? []) {
      const value = token.toLowerCase()
      if ((ReasoningEfforts as readonly string[]).includes(value)) return value as ReasoningEffort
    }
  }
  return "minimal"
}

export const reasoningEffortFailure = (failure: unknown): ReasoningEffort | undefined => {
  const classified =
    failure instanceof LLMError
      ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "reasoning-effort"
        ? failure.reason.message
        : undefined
      : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "reasoning-effort"
        ? failure.message
        : undefined
  return classified === undefined ? undefined : reasoningEffortFloorFrom(classified)
}

export const mediaLimitFailure = (failure: unknown): number | undefined => {
  const classified =
    failure instanceof LLMError
      ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "media-limit"
        ? failure.reason.message
        : undefined
      : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "media-limit"
        ? failure.message
        : undefined
  return classified === undefined ? undefined : (imageLimitFrom(classified) ?? 0)
}

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"

/**
 * The ONE place a provider's 4xx body becomes a classification, so the three protocol sites cannot
 * drift apart about the same message.
 *
 * ⚠️ ORDER MATTERS: an endpoint that refuses a request carrying many large images can word the
 * refusal as a length problem, and a message naming images is the more specific reading — treating
 * it as an overflow would trigger COMPACTION, which summarises text and removes not one image.
 * The recovery that fits the fault is the budget, so the media test runs first.
 */
export const classify = (message: string): "context-overflow" | "media-limit" | "reasoning-effort" | undefined =>
  isMediaLimit(message)
    ? "media-limit"
    : isReasoningEffortUnsupported(message)
      ? "reasoning-effort"
      : isContextOverflow(message)
        ? "context-overflow"
        : undefined
