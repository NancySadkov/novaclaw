import { describe, expect, test } from "bun:test"
import { AgentModelFit } from "./model-fit"

// Whether the model behind a colleague is up to its job (`notes/named-agents.md`).

describe("the floor comparison", () => {
  test("a model beneath the declared floor is below it", () => {
    expect(AgentModelFit.below({ needs: 70, bound: 12 })).toBe(true)
    expect(AgentModelFit.below({ needs: 50, bound: 35 })).toBe(true)
  })

  test("meeting the floor exactly is NOT below it", () => {
    // Off-by-one here warns every single turn on a correctly configured colleague, which trains the
    // user to ignore the warning that matters.
    expect(AgentModelFit.below({ needs: 50, bound: 50 })).toBe(false)
  })

  test("a stronger model is never a complaint", () => {
    expect(AgentModelFit.below({ needs: 25, bound: 80 })).toBe(false)
  })

  // 🔴 The two silences, which are different from a low score and from each other.
  test("no declared floor is SILENCE, not a score of zero", () => {
    expect(AgentModelFit.below({ needs: undefined, bound: 5 })).toBe(false)
  })

  test("an UNKNOWN model score is not a low one", () => {
    // ⚠️ Most models on a local-first install are hand-added and may carry no score. Treating "we do not
    // know" as "too weak" would warn on nearly every endpoint the owner actually runs — a warning
    // that fires on normal is not a warning.
    expect(AgentModelFit.below({ needs: 80, bound: undefined })).toBe(false)
  })
})

describe("what the colleague is told", () => {
  const spoken = AgentModelFit.notice({ needs: 70, bound: 18.2, model: "spark-holo/holo3.1" })

  test("names both scores, the model, and what to DO about it", () => {
    expect(spoken).toContain("spark-holo/holo3.1")
    expect(spoken).toContain("18.2%")
    expect(spoken).toContain("70.0%")
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
