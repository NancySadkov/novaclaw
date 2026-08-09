import { describe, expect, test } from "bun:test"
import { TurnTiming } from "./turn-timing"

describe("TurnTiming", () => {
  test("retains ordered phases and every provider retry", () => {
    let now = 100
    const timing = TurnTiming.make(() => now)
    timing.start("prepare")
    now = 120
    timing.end("prepare")
    timing.queued()
    now = 130
    timing.admitted()
    timing.attemptStarted(1)
    now = 150
    timing.attemptSettled(1, "retry")
    now = 160
    timing.attemptStarted(2)
    now = 190
    timing.firstToken()
    now = 220
    timing.attemptSettled(2, "completed")

    expect(timing.snapshot()).toEqual({
      startedAt: 100,
      completedAt: 220,
      phases: [
        { phase: "prepare", startedAt: 100, completedAt: 120 },
        { phase: "scheduler-wait", startedAt: 120, completedAt: 130 },
        { phase: "provider-prefill", startedAt: 130, completedAt: 150 },
        { phase: "provider-prefill", startedAt: 160, completedAt: 190 },
        { phase: "generation", startedAt: 190, completedAt: 220 },
      ],
      providerAttempts: [
        { attempt: 1, dispatchedAt: 130, completedAt: 150, outcome: "retry" },
        { attempt: 2, dispatchedAt: 160, firstTokenAt: 190, completedAt: 220, outcome: "completed" },
      ],
    })
  })

  test("leaves an active phase explicitly open in a live snapshot", () => {
    const timing = TurnTiming.make(() => 10)
    timing.start("memory-search")
    expect(timing.snapshot().phases).toEqual([{ phase: "memory-search", startedAt: 10 }])
  })
})
