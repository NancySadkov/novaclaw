import { describe, expect, test } from "bun:test"
import { AgentModelFit } from "@novaclaw/core/agent/model-fit"
import { TIER_CHOICES } from "@/apps/agent-model"

// 🔴 A HAND-KEPT COPY OF AN ORDERED LIST, pinned to the thing it copies.
//
// The dialog cannot import the ladder's ORDER from a schema — `ModelV2.Tier` is a union of strings and
// says nothing about which is stronger. So the picker spells the order out, and this asserts the two
// have not drifted: a tier added to the model schema and not here is a floor the user cannot choose,
// and one reordered here is a warning that fires on the wrong models. Neither fails anything else.
//
// This is the fourth instance of that shape in one session (`hand-kept-subset-of-a-schema`), which is
// why it gets a test rather than a comment asking the next person to remember.

describe("the config dialog's tier ladder", () => {
  test("is exactly the fit module's ladder, in the same order", () => {
    expect([...TIER_CHOICES]).toEqual([...AgentModelFit.LADDER])
  })

  test("is ordered weakest-first, which is what the picker's meaning rests on", () => {
    expect(TIER_CHOICES[0]).toBe("micro")
    expect(TIER_CHOICES[TIER_CHOICES.length - 1]).toBe("frontier")
  })
})
