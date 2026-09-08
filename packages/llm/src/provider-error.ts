import { Schema } from "effect"
import { LLMError, ProviderErrorEvent } from "./schema"

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
export const classify = (message: string): "context-overflow" | "media-limit" | undefined =>
  isMediaLimit(message) ? "media-limit" : isContextOverflow(message) ? "context-overflow" : undefined

