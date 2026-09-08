import { describe, expect, test } from "bun:test"
import { Token } from "./token"

// A CJK ideograph built from its code point (no literal non-ASCII in source).
const cjk = (count: number) => String.fromCharCode(0x4e00).repeat(count)

describe("Token.estimate", () => {
  test("empty string is zero", () => {
    expect(Token.estimate("")).toBe(0)
  })

  test("Latin prose stays near the ~chars/4 rule", () => {
    const text = "The quick brown fox jumps over the lazy dog."
    expect(Token.estimate(text)).toBeGreaterThanOrEqual(Math.round(text.length / 4))
    expect(Token.estimate(text)).toBeLessThanOrEqual(Math.round(text.length / 4) + 2)
  })

  test("ASCII code is denser than prose rather than inheriting chars/4", () => {
    const code = "const x = arr.map((y) => y * 2).filter(Boolean)"
    expect(Token.estimate(code)).toBeGreaterThan(Math.round(code.length / 4))
  })

  test("CJK is counted denser than a flat chars/4 — fixes the ~2.5x under-count", () => {
    const zh = cjk(10)
    expect(Token.estimate(zh)).toBe(Math.ceil(10 / 1.5))
    expect(Token.estimate(zh)).toBeGreaterThan(Math.round(zh.length / 4))
  })

  test("mixed Latin + CJK weights each run independently", () => {
    const mixed = "hello " + cjk(2) // 6 Latin (incl. the space) + 2 CJK
    expect(Token.estimate(mixed)).toBe(Math.ceil(5 / 4 + 1 / 4 + 2 / 1.5))
  })

  test("bare numbers use the measured one-character-per-token floor", () => {
    const digits = "0123456789".repeat(100)
    expect(Token.estimate(digits)).toBe(digits.length)
    expect(Token.estimate(digits)).toBe(4 * Math.round(digits.length / 4))
  })

  test("long high-entropy runs cannot hide behind the prose divisor", () => {
    const base64 = "Ab3+/xYz9_Qp7LmN2RstUvWx4KjH6Cde".repeat(20)
    expect(Token.estimate(base64)).toBeGreaterThan(base64.length / 1.3)
  })

  test("compact JSON and paths are charged by their own shapes", () => {
    const json = JSON.stringify({ ids: Array.from({ length: 50 }, (_, index) => `${index}`), ok: true })
    const path = "C:/deep/project/generated/assets/0123456789abcdef/result.json"
    expect(Token.estimate(json)).toBeGreaterThan(json.length / 4)
    expect(Token.estimate(path)).toBeGreaterThan(path.length / 4)
  })

  test("non-ASCII outside CJK is priced from UTF-8 bytes", () => {
    const emoji = String.fromCodePoint(0x1f680).repeat(20)
    expect(Token.estimate(emoji)).toBeGreaterThan(emoji.length / 1.5)
  })

  test("long indentation does not inherit a blanket dense-text multiplier", () => {
    const indented = `${" ".repeat(80)}value`
    expect(Token.estimate(indented)).toBeLessThan(indented.length / 2)
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
