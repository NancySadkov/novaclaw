import { describe, expect, test } from "bun:test"
import { TierScaffold } from "@novaclaw/core/session/runner/tier-scaffold"

describe("tierScaffold", () => {
  test("weak tiers get an explicit work-in-small-verified-steps stance", () => {
    expect(TierScaffold.tierScaffold("micro")).toContain("SMALL, VERIFIED steps")
    expect(TierScaffold.tierScaffold("tiny")).toContain("SMALL, VERIFIED steps")
    expect(TierScaffold.tierScaffold("micro")).toBe(TierScaffold.tierScaffold("tiny"))
  })

  test("small gets a lighter nudge", () => {
    const small = TierScaffold.tierScaffold("small")
    expect(small).toContain("verify each one")
    expect(small).not.toBe(TierScaffold.tierScaffold("micro"))
  })

  test("capable tiers and unknown get no scaffolding", () => {
    expect(TierScaffold.tierScaffold("medium")).toBeUndefined()
    expect(TierScaffold.tierScaffold("large")).toBeUndefined()
    expect(TierScaffold.tierScaffold("frontier")).toBeUndefined()
    expect(TierScaffold.tierScaffold(undefined)).toBeUndefined()
  })
})
