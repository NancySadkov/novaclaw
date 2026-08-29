import { describe, expect, test } from "bun:test"
import { estimate } from "@novaclaw/core/session/compaction"

/**
 * ── WHAT A MEDIA PART COSTS THE COMPACTION THRESHOLD ─────────────────────────────────────────────
 *
 * 🔴 Measured against the Spark 2026-08-29, two requests differing only by the image part: a 256 px
 * icon costs the provider **66 prompt tokens**, CONSTANT across a 27 KB and a 49 KB PNG, and two
 * images cost exactly 132. `JSON.stringify` of one such part is 47,000 characters of base64, which
 * `Token.estimate` priced at **11,772** — a 178x over-count, 250x on a larger file.
 *
 * The consequence was not academic. With this model's trigger at
 * `262,144 − max(32,768, 20,000)` = 229,376, twenty images alone compacted a session — images the
 * provider would charge 1,320 tokens for, **0.5 % of the window they were being evicted from**.
 *
 * ⚠️ The SHAPE was the real defect, not the scale. The old estimate tracked base64 LENGTH; the
 * provider tracks image COUNT. So the second test below matters more than the first: a fix that
 * merely divided by a constant would still have grown with how badly a PNG compressed.
 */

const media = (bytes: number) => ({
  type: "media",
  mediaType: "image/png",
  data: `data:image/png;base64,${"A".repeat(bytes)}`,
  filename: "icon.png",
})

const request = (...parts: unknown[]) => ({
  system: ["You describe images."],
  messages: [{ role: "user", content: parts }],
  tools: [],
})

describe("the compaction threshold prices a media part by COUNT, not by payload", () => {
  test("one image does not cost eleven thousand tokens", () => {
    // 47,000 base64 chars — the real size of this programme's corpus icons.
    const withImage = estimate(request({ type: "text", text: "describe it" }, media(47_000)))
    expect(withImage, "the old estimate scored this at ~11,772").toBeLessThan(3_000)
    expect(withImage, "but a media part is not free either").toBeGreaterThan(1_000)
  })

  // 🔴 THE SHAPE. Two icons from one corpus differed 139x vs 250x purely by compression.
  test("payload size does not change the estimate — the model never sees those bytes", () => {
    const small = estimate(request(media(36_000)))
    const large = estimate(request(media(66_000)))
    expect(large).toBe(small)
  })

  test("and it scales with the NUMBER of images, which is what the provider charges for", () => {
    const one = estimate(request(media(47_000)))
    const three = estimate(request(media(47_000), media(47_000), media(47_000)))
    // Two more images add two more media charges. Not asserted to the token, because the JSON
    // punctuation around the extra parts is real content the text half legitimately counts.
    const perImage = three - one
    expect(perImage).toBeGreaterThan(2_900)
    expect(perImage).toBeLessThan(3_100)
  })

  // ⚠️ Text must be untouched: chars/4 is close for prose and this fix must not disturb it.
  test("text is still counted by its characters", () => {
    const short = estimate(request({ type: "text", text: "x".repeat(40) }))
    const long = estimate(request({ type: "text", text: "x".repeat(4_040) }))
    expect(long - short).toBeGreaterThan(950)
    expect(long - short).toBeLessThan(1_050)
  })
})
