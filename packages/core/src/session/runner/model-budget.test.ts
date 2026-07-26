import { describe, expect, test } from "bun:test"
import { defaultThinkingBudget } from "./model"

// The reasoning-token ceiling. The trap this pins: a CONFIGURED value used to be returned raw, so a budget
// larger than the model could ever emit meant no checkpoint could fire and the whole controller went inert
// — silently. A real `600060006000` (settings append-bug artifact) was found in the owner's config.

const CONTEXT = 128_000
const OUTPUT = 32_000

describe("defaultThinkingBudget", () => {
  test("unset: a quarter of the context, capped by the output limit", () => {
    expect(defaultThinkingBudget(undefined, CONTEXT, OUTPUT)).toBe(32_000)
    expect(defaultThinkingBudget(undefined, 40_000, OUTPUT)).toBe(10_000)
    expect(defaultThinkingBudget(undefined, CONTEXT, 0)).toBe(32_000)
    expect(defaultThinkingBudget(undefined, 0, OUTPUT)).toBe(0)
  })

  test("configured: honoured as given when reachable — including ABOVE the default", () => {
    expect(defaultThinkingBudget(6_000, CONTEXT, OUTPUT)).toBe(6_000)
    // More thinking than the default quarter is a legitimate choice; only the unreachable is clamped.
    expect(defaultThinkingBudget(31_000, CONTEXT, OUTPUT)).toBe(31_000)
  })

  test("configured: clamped to what the model can actually emit", () => {
    // The fat-fingered value that made the feature inert.
    expect(defaultThinkingBudget(600_060_006_000, CONTEXT, OUTPUT)).toBe(OUTPUT)
    expect(defaultThinkingBudget(999_999, CONTEXT, OUTPUT)).toBe(OUTPUT)
    // No output limit declared → the context is the bound.
    expect(defaultThinkingBudget(999_999, CONTEXT, 0)).toBe(CONTEXT)
  })

  test("configured: degenerate values never produce a negative or fractional ceiling", () => {
    expect(defaultThinkingBudget(-5, CONTEXT, OUTPUT)).toBe(0)
    expect(defaultThinkingBudget(0, CONTEXT, OUTPUT)).toBe(0) // 0 = the documented "off" sentinel
    expect(defaultThinkingBudget(1234.7, CONTEXT, OUTPUT)).toBe(1234)
  })

  // The model dialog writes -1 for its "Disabled" budget option (owner 2026-07-26). It must collapse to 0,
  // because the runner gates the whole controller on `thinkingBudget > 0` — if -1 ever survived as a
  // ceiling the controller would engage and cut reasoning immediately.
  test("-1 is the DISABLED sentinel the model dialog writes, and it means off", () => {
    expect(defaultThinkingBudget(-1, CONTEXT, OUTPUT)).toBe(0)
    expect(defaultThinkingBudget(-1, 0, 0)).toBe(0)
  })
})
