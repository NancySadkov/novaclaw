import { describe, expect, test } from "bun:test"
import { AgentModelFit } from "./model-fit"
import { ModelTaxonomy } from "../model-taxonomy"

// Whether the model behind a colleague is up to its job (`notes/named-agents.md`).

describe("the class comparison", () => {
  test("a model beneath the declared class is below it", () => {
    expect(AgentModelFit.below({ needs: "smart", bound: "fast" })).toBe(true)
    expect(AgentModelFit.below({ needs: "smart", bound: "usual" })).toBe(true)
    expect(AgentModelFit.below({ needs: "usual", bound: "fast" })).toBe(true)
  })

  test("meeting the class exactly is NOT below it", () => {
    // An off-by-one here warns every single turn on a correctly configured colleague, which trains
    // the user to ignore the warning that matters.
    expect(AgentModelFit.below({ needs: "usual", bound: "usual" })).toBe(false)
    expect(AgentModelFit.below({ needs: "fast", bound: "fast" })).toBe(false)
  })

  test("a stronger model is never a complaint", () => {
    expect(AgentModelFit.below({ needs: "fast", bound: "smart" })).toBe(false)
    expect(AgentModelFit.below({ needs: "usual", bound: "smart" })).toBe(false)
  })

  // ⚠️ There is no "unknown model" case any more, and that is the taxonomy's doing rather than an
  // omission: an unrated model READS as `usual` at every comparison (`ModelTaxonomy.of`), which is
  // what makes Usual a real default instead of a gap. A role that asks for `smart` is therefore told
  // when its unrated model is only Usual-grade — the honest answer under a three-word scale — while
  // a role that never declared a class stays silent, because `llm.ts` simply does not call this.
  test("an unrated model is compared as Usual, never as Fast", () => {
    const unrated = ModelTaxonomy.of({ taxonomy: undefined })
    expect(unrated).toBe("usual")
    expect(AgentModelFit.below({ needs: "usual", bound: unrated })).toBe(false)
    expect(AgentModelFit.below({ needs: "smart", bound: unrated })).toBe(true)
  })
})

describe("what the colleague is told", () => {
  const spoken = AgentModelFit.notice({ needs: "smart", bound: "fast", model: "spark-holo/holo3.1" })

  test("names both classes, the model, and what to DO about it", () => {
    expect(spoken).toContain("spark-holo/holo3.1")
    expect(spoken).toContain("Fast")
    expect(spoken).toContain("Smart")
    // "It warns; it never refuses" — the text must not tell a model to stop.
    expect(spoken.toLowerCase()).toContain("carry on")
  })

  // 🔴 THE ROUND TRIP. `alreadyTold` finds a past notice by its opening clause, so a reworded notice
  // that no longer contains it would make the colleague warn again EVERY TURN — and nothing would
  // fail. Both are derived from `opening` now, so this asserts the derivation still holds rather
  // than the wording.
  test("a notice is FINDABLE by the check that suppresses it", () => {
    expect(AgentModelFit.alreadyTold({ transcript: [spoken], model: "spark-holo/holo3.1" })).toBe(true)
  })

  test("a notice about a DIFFERENT model does not suppress this one", () => {
    // Re-binding to another weak model is a new fact and gets said again; the warning's identity is
    // the binding it is about.
    expect(AgentModelFit.alreadyTold({ transcript: [spoken], model: "endpoint-a/qwen-0.5b" })).toBe(false)
  })

  test("an empty transcript has told nobody anything", () => {
    expect(AgentModelFit.alreadyTold({ transcript: [], model: "spark-holo/holo3.1" })).toBe(false)
  })

  test("a transcript that merely MENTIONS the model has not told it", () => {
    // A user asking "why are you on holo3.1?" must not suppress the notice.
    expect(
      AgentModelFit.alreadyTold({
        transcript: ["user: why are you running spark-holo/holo3.1 today?"],
        model: "spark-holo/holo3.1",
      }),
    ).toBe(false)
  })
})
