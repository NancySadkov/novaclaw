import { describe, expect, test } from "bun:test"
import { Token } from "./token"

// A CJK ideograph built from its code point (no literal non-ASCII in source).
const cjk = (count: number) => String.fromCharCode(0x4e00).repeat(count)

describe("Token.estimate", () => {
  test("empty string is zero", () => {
    expect(Token.estimate("")).toBe(0)
  })

  test("Latin prose stays on the ~chars/4 rule (backward-compatible with the old flat estimate)", () => {
    const text = "The quick brown fox jumps over the lazy dog."
    expect(Token.estimate(text)).toBe(Math.round(text.length / 4))
  })

  test("ASCII code also stays on chars/4 (no CJK to reweight)", () => {
    const code = "const x = arr.map((y) => y * 2).filter(Boolean)"
    expect(Token.estimate(code)).toBe(Math.round(code.length / 4))
  })

  test("CJK is counted denser than a flat chars/4 — fixes the ~2.5x under-count", () => {
    const zh = cjk(10)
    expect(Token.estimate(zh)).toBe(Math.round(10 / 1.7)) // ~6, not the naive 3
    expect(Token.estimate(zh)).toBeGreaterThan(Math.round(zh.length / 4))
  })

  test("mixed Latin + CJK weights each run independently", () => {
    const mixed = "hello " + cjk(2) // 6 Latin (incl. the space) + 2 CJK
    expect(Token.estimate(mixed)).toBe(Math.round(6 / 4 + 2 / 1.7))
  })
})

describe("Token.estimateFromChars", () => {
  test("flat chars/4 for a known character count", () => {
    expect(Token.estimateFromChars(400)).toBe(100)
  })

  test("zero and negatives clamp to 0", () => {
    expect(Token.estimateFromChars(0)).toBe(0)
    expect(Token.estimateFromChars(-5)).toBe(0)
  })
})
