import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DateTime } from "effect"
import { Token } from "@novaclaw/core/util/token"
import { SessionMessage } from "@novaclaw/core/session/message"
import { estimateMessage } from "@novaclaw/core/session/runner/context-pack"
import { outputTokens } from "@novaclaw/core/session/compaction-prune"

/**
 * ── ONE ESTIMATOR, THREE CALL SITES, A WIRING TEST EACH ──────────────────────────────────────────
 *
 * 🔴 `Token.estimate(JSON.stringify(value))` was written independently in three places — WHEN to
 * compact, WHAT FITS the window, and WHICH tool outputs to ERASE — and all three inherited the same
 * error: a base64 image priced at ~11,772 tokens against a provider's measured **66**.
 *
 * The pruner's was the worst and it was backwards. It weighs erase-candidates by this number, so an
 * image looked like 11,772 tokens of reclaimable space and is worth 66 — it destroyed the pictures,
 * the one content the model cannot rebuild from text, for nothing, and reported a reclaim that never
 * happened.
 *
 * ⚠️ **Each site gets its own test against the shape IT receives.** The first attempt at this fix
 * matched only `type: "media"` and was inert for tool-returned images, and its four tests passed
 * because they hand-built the part. `context-pack` sees a SessionMessage's `content`; the pruner sees
 * `{structured, content}` off a completed tool state. A shared fixture would hide a difference
 * between them, which is the whole failure mode being guarded.
 */

const created = DateTime.makeUnsafe(0)
/** A real 256x256 PNG: every consumer must reach its 66-token dimensions, not the fallback. */
const GLYPH = path.join(import.meta.dir, "..", "..", "app", "public", "assets", "skin", "glyphs", "calendar.png")
const BIG = readFileSync(GLYPH).toString("base64")

const imageToolPart = () =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: "call_1",
    name: "read",
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: {},
      content: [
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${BIG}`, mime: "image/png", name: "icon_001.png" },
      ],
      structured: {},
      result: undefined,
    }),
    time: { created, completed: created },
  })

const assistantWithImage = () =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make("msg_media"),
    type: "assistant",
    agent: "build",
    model: { id: "model" as never, providerID: "provider" as never },
    content: [imageToolPart()],
    time: { created, completed: created },
  })

/** chars/4 over the raw base64 — what every site produced before the fix. */
const NAIVE = Math.round(BIG.length / 4)

describe("every site that prices content prices an image the same way", () => {
  test("the shared estimator itself", () => {
    const part = { type: "file", uri: `data:image/png;base64,${BIG}`, mime: "image/png" }
    expect(Token.estimateStructured(part)).toBeGreaterThanOrEqual(66)
    expect(Token.estimateStructured(part)).toBeLessThan(200)
    expect(NAIVE).toBeGreaterThan(5_000) // the base64 estimate it replaces, kept visible
  })

  // 🔴 WHAT FITS THE WINDOW. Over-pricing here drops history the model had room for.
  test("context-pack's estimateMessage, on a real assistant message", () => {
    const tokens = estimateMessage(assistantWithImage() as never)
    expect(tokens, "a real icon must reach its measured 66-token dimensions").toBeGreaterThanOrEqual(66)
    expect(tokens, "an image must not cost thousands of tokens of window").toBeLessThan(500)
  })

  // 🔴 WHICH OUTPUTS GET ERASED. This one destroys content when it is wrong.
  test("compaction-prune's outputTokens, on a real completed tool state", () => {
    const tokens = outputTokens(imageToolPart() as never)
    expect(tokens, "a real icon must reach its measured 66-token dimensions").toBeGreaterThanOrEqual(66)
    expect(tokens, "erasing this image reclaims ~66 provider tokens, not its base64 length").toBeLessThan(500)
  })

  // ⚠️ Text must be untouched at every site — chars/4 is close for prose and the fix must not move it.
  test("a TEXT tool result is still priced by its characters", () => {
    const textual = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_2",
      name: "read",
      state: SessionMessage.ToolStateCompleted.make({
        status: "completed",
        input: {},
        content: [{ type: "text", text: "x".repeat(40_000) }],
        structured: {},
        result: undefined,
      }),
      time: { created, completed: created },
    })
    expect(outputTokens(textual as never)).toBeGreaterThan(9_000)
  })
})

/**
 * ⚠️ THE ERROR PATH, which the refactor silently changed.
 *
 * `context-pack`'s `estimateMessage` used to fall back to `estimate(String(value))` when
 * `JSON.stringify` threw. Collapsing three call sites onto one helper replaced that with `return 0`
 * — and zero tells the packer a message is FREE, so it over-packs a window it believes is empty.
 * Found by reading the diff, not by a failing test: nothing here constructs a circular message.
 */
describe("an unstringifiable value is expensive, not free", () => {
  test("a circular structure retains the text it actually contains", () => {
    const circular: Record<string, unknown> = { type: "text", text: "x".repeat(400) }
    circular["self"] = circular
    expect(Token.estimateStructured(circular)).toBeGreaterThan(100)
    expect(Token.estimateStructured(circular)).toBeLessThan(200)
  })

  test("a hostile getter saturates at a finite safe estimate", () => {
    const hostile = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("no inspection")
      },
    })
    expect(Token.estimateStructured(hostile)).toBe(Number.MAX_SAFE_INTEGER)
  })
})
