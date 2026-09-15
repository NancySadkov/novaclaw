/**
 * `boundOversizedMessage` — the bound for ONE message larger than the whole window.
 *
 * ⚠️ **NOT WIRED YET.** Nothing in `context-pack.ts` calls this helper; it is the first cut at the
 * open item "a single inserted item larger than the whole window is NAMED, not PREVENTED". These
 * pins exist because the helper is committed: a committed export whose contract is asserted nowhere
 * is a claim nobody can check, and the contract here is the one the whole helper exists for — that
 * what it returns FITS.
 */
import { describe, expect, test } from "bun:test"
import { Message } from "@novaclaw/llm"
import { Token } from "../../util/token"
import {
  boundOversizedMessage,
  estimateMessage,
  oversizedMarker,
  OVERSIZED_MARKER_TOKENS,
} from "./context-pack"

/** Plain prose, so the estimator's ordinary path is the one under test. */
const PROSE = "The quick brown fox jumps over the lazy dog and explains the packing layer in detail. "
const HUGE = PROSE.repeat(20_000)

/** The bounded text, split back into its three pieces: head, marker, tail. */
const pieces = (message: Message) => {
  const text = (message.content[0] as { text: string }).text
  const [head, marker, tail] = text.split("\n\n")
  return { text, head: head!, marker: marker!, tail: tail! }
}

describe("boundOversizedMessage", () => {
  test("a message that already fits is left alone", () => {
    expect(boundOversizedMessage(Message.user("hello"), 10_000)).toBeUndefined()
  })

  test("🔴 the message it returns FITS the allowance it was given, marker included", () => {
    // The declared reservation exists so "the bound cannot be exceeded by its own explanation".
    // Measured, not assumed: the estimator that will judge this message is the one called here.
    for (const allowance of [20_000, 60_000]) {
      const bounded = boundOversizedMessage(Message.user(HUGE), allowance)
      expect(bounded, `allowance ${allowance}`).toBeDefined()
      const measured = estimateMessage(bounded!)
      console.log(`  allowance ${allowance} -> ${measured} tok (${(measured / allowance).toFixed(4)}x)`)
      expect(measured, `allowance ${allowance}`).toBeLessThanOrEqual(allowance)
    }
  })

  test("both ends survive — the instruction at the end is not the part that gets deleted", () => {
    const bounded = boundOversizedMessage(Message.user(HUGE), 20_000)!
    const { head, tail } = pieces(bounded)
    expect(head.startsWith(PROSE.slice(0, 40))).toBe(true)
    expect(tail.endsWith(PROSE.slice(-40))).toBe(true)
    expect(head.length).toBeGreaterThan(0)
    expect(tail.length).toBeGreaterThan(0)
  })

  test("the marker states the EXACT size withheld, and the two pieces account for the rest", () => {
    const bounded = boundOversizedMessage(Message.user(HUGE), 20_000)!
    const { head, marker, tail } = pieces(bounded)
    const omitted = HUGE.length - head.length - tail.length
    // A truncation the reader cannot size is a lie about what the model was told.
    expect(marker).toBe(oversizedMarker(omitted, HUGE.length))
    expect(marker).toContain(omitted.toLocaleString("en-US"))
    expect(marker).toContain(HUGE.length.toLocaleString("en-US"))
  })

  test("the reservation the marker spends is really taken out of the allowance", () => {
    // 🔴 The constant was declared and never spent: the budget came from the whole allowance and the
    // marker was appended on top, so the returned message could exceed the allowance by the marker's
    // own cost — the exact failure the comment says it prevents.
    const allowance = 20_000
    const { head, tail } = pieces(boundOversizedMessage(Message.user(HUGE), allowance)!)
    // ⚠️ Character level, not token level: the estimator also prices the JSON envelope around the
    // text (~10 tokens), so comparing a re-measured message to the raw budget is off by that much.
    // The characters kept are what the reservation actually governs.
    expect(head.length + tail.length).toBeLessThanOrEqual(Token.charsFromTokens(allowance - OVERSIZED_MARKER_TOKENS))
  })

  test("a message carrying media or a tool result is refused, never rewritten", () => {
    const withImage = Message.user([
      { type: "text", text: "x".repeat(500_000) },
      { type: "media", mediaType: "image/png", data: "aGk=" },
    ] as never)
    expect(boundOversizedMessage(withImage as never, 100)).toBeUndefined()
    expect(boundOversizedMessage(Message.tool({ id: "t1", name: "read", result: "y".repeat(500_000) }), 100)).toBeUndefined()
  })

  test("a surrogate pair is never cut in half — a lone half renders as a replacement glyph", () => {
    const emoji = "🙂".repeat(50_000)
    const bounded = boundOversizedMessage(Message.user(emoji), 1_000)
    if (bounded === undefined) return
    const { head, tail } = pieces(bounded)
    for (const piece of [head, tail]) {
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(piece)).toBe(false)
    }
  })
})
