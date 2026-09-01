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
  })

  // 🔴 This assertion read `compactTokens(32768)).toBe("32.8k")`. It was pinning a LOCAL copy of the
  // formatter, and the Chats list — which renders the same counts on the same screen — rendered that
  // number "33k". Three significant figures is the rule now: a tenth is informative at 1.5k and noise at
  // 33k. The assertion is not dropped, it is corrected to the shared rule.
  test("above 10k the tenth is dropped, matching the Chats list on the same screen", () => {
    expect(compactTokens(32768)).toBe("33k")
    expect(compactTokens(9999)).toBe("10.0k")
  })

  // The whole point of sharing: the local copy had no megabyte branch, so a long reasoning fold read
  // "1200.0k" beside a "1.2M" elsewhere in the UI.
  test("millions get a megabyte branch instead of running off the end of k", () => {
    expect(compactTokens(1_200_000)).toBe("1.2M")
    expect(compactTokens(12_000_000)).toBe("12M")
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
