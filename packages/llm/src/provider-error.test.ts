import { describe, expect, test } from "bun:test"
import { classify, imageLimitFrom, isContextOverflow, isMediaLimit } from "./provider-error"

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
const MEASURED = 'At most 3 image(s) may be provided in one prompt. (parameter=image)'

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
