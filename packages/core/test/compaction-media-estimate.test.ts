import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DateTime } from "effect"
import { Model } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { SessionMessage } from "@novaclaw/core/session/message"
import { toLLMMessages } from "@novaclaw/core/session/runner/to-llm-message"
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

const glyph = (name: string) =>
  readFileSync(path.join(import.meta.dir, "..", "..", "app", "public", "assets", "skin", "glyphs", name)).toString(
    "base64",
  )
const CALENDAR = glyph("calendar.png")
const CHATS = glyph("chats.png")

const media = (data = CALENDAR) => ({
  type: "media",
  mediaType: "image/png",
  data: `data:image/png;base64,${data}`,
  filename: "icon.png",
})

const request = (...parts: unknown[]) => ({
  system: ["You describe images."],
  messages: [{ role: "user", content: parts }],
  tools: [],
})

describe("the compaction threshold prices media by measured dimensions, not payload", () => {
  test("one real 256px image lands near its measured 66 tokens", () => {
    const withImage = estimate(request({ type: "text", text: "describe it" }, media()))
    expect(withImage, "the old estimate counted thousands of base64 tokens").toBeLessThan(200)
    expect(withImage, "the measured image charge must not disappear").toBeGreaterThanOrEqual(66)
  })

  // 🔴 THE SHAPE. These are two valid 256px PNGs with different encoded sizes and the same patch grid.
  test("file size does not change the estimate when dimensions are identical", () => {
    const small = estimate(request(media(CHATS)))
    const large = estimate(request(media(CALENDAR)))
    expect(large).toBe(small)
  })

  test("and it scales with each image's measured patch-grid charge", () => {
    const one = estimate(request(media()))
    const three = estimate(request(media(), media(), media()))
    // Two more images add two more media charges. Not asserted to the token, because the JSON
    // punctuation around the extra parts is real content the text half legitimately counts.
    const perImage = three - one
    expect(perImage).toBeGreaterThan(130)
    // Content-shape estimation deliberately prices compact object syntax more densely than prose.
    // The media law still dominates and, critically, this allowance is constant per part rather
    // than growing with the base64 payload.
    expect(perImage).toBeLessThan(240)
  })

  test("a route-specific patch side changes the compaction threshold by that image's exact grid delta", () => {
    const value = request(media())
    const defaultEstimate = estimate(value)
    const fineGridEstimate = estimate(value, 16)

    expect(fineGridEstimate - defaultEstimate).toBe(258 - 66)
  })

  // ⚠️ Text must be untouched: chars/4 is close for prose and this fix must not disturb it.
  test("text is still counted by its characters", () => {
    const short = estimate(request({ type: "text", text: "x".repeat(40) }))
    const long = estimate(request({ type: "text", text: "x".repeat(4_040) }))
    expect(long - short).toBeGreaterThan(950)
    expect(long - short).toBeLessThan(1_050)
  })
})

/**
 * ── THE WIRING, ON A GENUINELY ASSEMBLED REQUEST ─────────────────────────────────────────────────
 *
 * 🔴 **The first version of this fix matched only `type: "media"` and was INERT for the workload that
 * motivated it.** A user attachment lowers to `media`; a TOOL RESULT keeps `{type:"file", mime, uri}`
 * — and every image in the batch-file programme arrives through the `read` TOOL. The tests above all
 * passed, because they hand-build the part they assert on. That is the fifth time this session a
 * helper proved itself while the caller went unchecked.
 *
 * So this one builds a real tool-result message, lowers it with the REAL `toLLMMessages`, and
 * estimates THAT. If the lowered shape ever changes, this fails; a hand-built part never would.
 */
describe("the wiring: a real lowered tool result", () => {
  const created = DateTime.makeUnsafe(0)

  const readResultWithImage = () =>
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_wiring"),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      content: [
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_1",
          name: "read",
          state: SessionMessage.ToolStateCompleted.make({
            status: "completed",
            input: {},
            content: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: `data:image/png;base64,${CALENDAR}`, mime: "image/png", name: "icon_001.png" },
            ],
            structured: {},
            result: undefined,
          }),
          time: { created, completed: created },
        }),
      ],
      time: { created, completed: created },
    })

  test("an image returned by the READ TOOL is not counted by its base64", () => {
    const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
    const lowered = toLLMMessages([readResultWithImage()], model, { input: ["text", "image"] })
    // Sanity: the payload really is in there, so a small estimate means the RULE fired, not that the
    // image was dropped somewhere upstream.
    expect(JSON.stringify(lowered)).toContain(CALENDAR.slice(0, 200))
    const tokens = estimate({ system: [], messages: lowered, tools: [] })
    expect(tokens).toBeGreaterThanOrEqual(66)
    expect(tokens).toBeLessThan(300)
  })
})
