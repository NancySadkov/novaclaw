import { describe, expect, test } from "bun:test"
import { compactTokens, reasoningTokenLabel } from "./reasoning-count"

describe("compactTokens", () => {
  test("small counts render exactly", () => {
    expect(compactTokens(0)).toBe("0")
    expect(compactTokens(234)).toBe("234")
    expect(compactTokens(999)).toBe("999")
  })
  test("thousands compact to one decimal + k", () => {
    expect(compactTokens(1000)).toBe("1.0k")
    expect(compactTokens(1500)).toBe("1.5k")
    expect(compactTokens(32768)).toBe("32.8k")
  })
})

describe("reasoningTokenLabel (reasoning fold counter — tokens, not chars)", () => {
  test("shows the provider's REAL reasoning-token count once settled", () => {
    expect(reasoningTokenLabel(234, "a".repeat(4000))).toBe("234")
    expect(reasoningTokenLabel(1500, "x")).toBe("1.5k")
  })

  test("falls back to a labeled ~chars/4 estimate while streaming (no usage yet)", () => {
    expect(reasoningTokenLabel(undefined, "a".repeat(400))).toBe("~100") // 400 chars ≈ 100 tokens
  })

  test("a zero placeholder is treated as not-yet-known → estimate, not '0'", () => {
    expect(reasoningTokenLabel(0, "a".repeat(40))).toBe("~10")
  })

  test("the estimate is in tokens, NOT the old raw character count", () => {
    const text = "a".repeat(800)
    expect(reasoningTokenLabel(undefined, text)).toBe("~200") // ~200 tokens, not "800"
  })
})
