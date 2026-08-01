import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigContext } from "../../config/context"
import { cap, DEFAULT_PROFILES, enabled, resolve } from "./context-budget"

describe("typed context budgets (A2.1 ②)", () => {
  test("compiled profiles spend exactly one window and give unattended work more tool room", () => {
    for (const profile of Object.values(DEFAULT_PROFILES)) {
      expect(Object.values(profile).reduce((sum, share) => sum + share, 0)).toBe(100)
    }
    expect(DEFAULT_PROFILES["goal-oriented"].tool_output).toBeGreaterThan(DEFAULT_PROFILES.interactive.tool_output)
    expect(DEFAULT_PROFILES.interactive.messages).toBeGreaterThan(DEFAULT_PROFILES["goal-oriented"].messages)
  })

  test("a live profile override is sparse and field-by-field", () => {
    const config = Schema.decodeUnknownSync(ConfigContext.Info)({ profiles: { interactive: { tool_output: 28 } } })
    expect(resolve(config, "interactive")).toEqual({
      ...DEFAULT_PROFILES.interactive,
      tool_output: 28,
    })
  })

  test("the per-session stance wins, then the instance setting, then the shipped default", () => {
    expect(enabled(undefined, undefined)).toBe(true)
    expect(enabled(ConfigContext.Info.make({ enabled: false }), undefined)).toBe(false)
    expect(enabled(ConfigContext.Info.make({ enabled: false }), true)).toBe(true)
    expect(enabled(ConfigContext.Info.make({ enabled: true }), false)).toBe(false)
  })

  test("shares decode only inside 0..100 and become deterministic token caps", () => {
    expect(cap(32_000, 25)).toBe(8_000)
    expect(() => Schema.decodeUnknownSync(ConfigContext.Profile)({ tool_output: 101 })).toThrow()
    expect(() => Schema.decodeUnknownSync(ConfigContext.Profile)({ tool_output: -1 })).toThrow()
  })
})
