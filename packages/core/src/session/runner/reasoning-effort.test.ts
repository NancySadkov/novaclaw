import { afterEach, describe, expect, test } from "bun:test"
import { ReasoningEffortFloor } from "./reasoning-effort"

/**
 * The in-process half of the learned no-thinking floor.
 *
 * It exists because the recovery that learns the floor re-runs the SAME turn, and that rebuild reads
 * it through `Model.compatibility` before any store round trip. `models.rememberReasoningEffortFloor`
 * writes here first for exactly that reason; this pins the read-back.
 */
describe("ReasoningEffortFloor", () => {
  afterEach(() => ReasoningEffortFloor.clear())

  const muse = { providerID: "gateway", id: "muse-spark-1.3-contributor" }

  test("remembers a floor per model, and only for the model it was learned on", () => {
    expect(ReasoningEffortFloor.isLearned(muse)).toBe(false)
    expect(ReasoningEffortFloor.floorFor(muse)).toBeUndefined()

    ReasoningEffortFloor.remember(muse, "minimal")

    expect(ReasoningEffortFloor.isLearned(muse)).toBe(true)
    expect(ReasoningEffortFloor.floorFor(muse)).toBe("minimal")
    // A different model on the same gateway is unaffected: the refusal names the model.
    expect(ReasoningEffortFloor.floorFor({ providerID: "gateway", id: "glm-5.3" })).toBeUndefined()
  })

  test("a later measurement replaces the earlier one", () => {
    ReasoningEffortFloor.remember(muse, "minimal")
    ReasoningEffortFloor.remember(muse, "low")
    expect(ReasoningEffortFloor.floorFor(muse)).toBe("low")
  })
})
