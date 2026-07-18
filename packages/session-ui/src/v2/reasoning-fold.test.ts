import { describe, expect, test } from "bun:test"
import { reasoningOpenDefault } from "./reasoning-fold"

describe("reasoningOpenDefault", () => {
  test("collapsed (Normal) stays folded regardless of streaming state", () => {
    expect(reasoningOpenDefault("collapsed", false)).toBe(false)
    expect(reasoningOpenDefault("collapsed", true)).toBe(false)
  })

  test("open (Developer) stays expanded regardless of streaming state", () => {
    expect(reasoningOpenDefault("open", false)).toBe(true)
    expect(reasoningOpenDefault("open", true)).toBe(true)
  })

  test("live (Advanced) is open while streaming, collapsed once complete", () => {
    expect(reasoningOpenDefault("live", false)).toBe(true)
    expect(reasoningOpenDefault("live", true)).toBe(false)
  })
})
