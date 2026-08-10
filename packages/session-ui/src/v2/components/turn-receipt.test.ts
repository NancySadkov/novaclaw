import { describe, expect, test } from "bun:test"
import { attemptLabel, currentPhase, elapsedMs, phaseLabel, seconds, type TurnTiming } from "./turn-receipt"

describe("turn receipt", () => {
  test("uses friendly labels and stable seconds", () => {
    expect(phaseLabel("memory-search")).toBe("Recalling")
    expect(phaseLabel("provider-prefill")).toBe("Waiting for the model")
    expect(seconds(elapsedMs(100, 1349, 9999))).toBe("1.2s")
    expect(seconds(elapsedMs(100, undefined, 650))).toBe("0.6s")
  })

  test("takes the newest server-owned open phase as the live label", () => {
    const timing = {
      startedAt: 100,
      phases: [
        { phase: "prepare", startedAt: 100, completedAt: 120 },
        { phase: "memory-search", startedAt: 120 },
      ],
      providerAttempts: [],
    } satisfies TurnTiming
    expect(currentPhase(timing)?.phase).toBe("memory-search")
  })

  test("names retries separately from ordinary attempts", () => {
    expect(attemptLabel({ attempt: 1, dispatchedAt: 100, completedAt: 200, outcome: "retry" })).toBe(
      "Retrying after attempt 1",
    )
    expect(attemptLabel({ attempt: 2, dispatchedAt: 210, completedAt: 300, outcome: "completed" })).toBe(
      "Model attempt 2",
    )
  })
})
