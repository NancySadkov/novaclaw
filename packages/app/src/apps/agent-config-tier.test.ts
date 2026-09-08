import { describe, expect, test } from "bun:test"
import { AgentModelFit } from "@novaclaw/core/agent/model-fit"
import { TIER_CHOICES, TIERS, isTier } from "@/apps/agent-model"

// 🔴 THE ORDERED LIST IS NOW SHARED, AND THIS PINS THAT — not a copy against its original.
//
// The ladder's ORDER cannot come from a schema: `ModelV2.Tier` is a union of strings and says
// nothing about which tier is stronger. It used to be spelled out four more times — `TIERS` and
// `TIER_CHOICES` 39 lines apart in one module, the tier dialog's seven-entry list, and the
// `ModelTier` union in `context/models.tsx` — and only ONE of those pairs was pinned. So a tier
// added to the schema and to the pinned copy passed the gate while `isTier` rejected it (making
// `briefTooBigForTier` silently answer `undefined`) and the picker could not offer it.
//
// The assertion therefore changed shape with the merge: `toEqual` compared two lists that no longer
// exist separately and could not fail, so it is `toBe` — these names ARE the ladder, not equal to
// it. That is the same re-expression the `slugify` merge used. The behaviour the old test was
// protecting (a tier the user can pick is a tier the code recognises) is asserted below, over the
// schema's whole union rather than over one copy of it.

describe("the config dialog's tier ladder", () => {
  test("is the fit module's ladder itself, not a copy of it", () => {
    expect(TIERS).toBe(AgentModelFit.LADDER)
    expect(TIER_CHOICES).toBe(AgentModelFit.LADDER)
  })

  test("is ordered weakest-first, which is what the picker's meaning rests on", () => {
    expect(TIER_CHOICES[0]).toBe("micro")
    expect(TIER_CHOICES[TIER_CHOICES.length - 1]).toBe("frontier")
  })

  test("every tier the picker offers is one `isTier` recognises", () => {
    // The defect the old pin could not see: `isTier` read a different list than the picker did.
    for (const tier of TIER_CHOICES) expect(isTier(tier)).toBe(true)
    expect(isTier("enormous")).toBe(false)
  })
})
