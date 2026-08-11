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
    expect(timing.live()).toEqual({
      startedAt: 10,
      phases: [{ phase: "memory-search", startedAt: 10 }],
      providerAttempts: [],
    })
  })

  test("closes the exact span when parallel work shares a phase", () => {
    let now = 10
    const timing = TurnTiming.make(() => now)
    const closeFirst = timing.begin("capability-run")
    now = 20
    const closeSecond = timing.begin("capability-run")
    now = 30
    closeFirst()
    now = 40
    closeSecond()

    expect(timing.snapshot().phases).toEqual([
      { phase: "capability-run", startedAt: 10, completedAt: 30 },
      { phase: "capability-run", startedAt: 20, completedAt: 40 },
    ])
  })

  test("nests repository detail under the active snapshot without changing its top-level phase", () => {
    let now = 10
    const timing = TurnTiming.make(() => now)
    timing.detailStart("status")
    timing.start("snapshot")
    timing.detailStart("repository")
    now = 20
    timing.detailEnd("repository")
    timing.detailStart("status")
    now = 30
    timing.detailEnd("status")
    timing.end("snapshot")

    expect(timing.snapshot().phases).toEqual([
      {
        phase: "snapshot",
        startedAt: 10,
        completedAt: 30,
        details: [
          { phase: "repository", startedAt: 10, completedAt: 20 },
          { phase: "status", startedAt: 20, completedAt: 30 },
        ],
      },
    ])
  })

  test("end() hands back the closed record, WITH its sub-timings", () => {
    // This is what lets the runner notice a long stage and say which part of it was slow, at the
    // one moment the breakdown exists. Without the return it would need a second stopwatch beside
    // this ledger, and two clocks for one stage eventually disagree.
    let now = 10
    const timing = TurnTiming.make(() => now)
    timing.start("snapshot-after")
    timing.detailStart("status")
    now = 40
    timing.detailEnd("status")
    timing.detailStart("hash")
    now = 50
    timing.detailEnd("hash")
    now = 60
    const closed = timing.end("snapshot-after")

    expect(closed).toEqual({
      phase: "snapshot-after",
      startedAt: 10,
      completedAt: 60,
      details: [
        { phase: "status", startedAt: 10, completedAt: 40 },
        { phase: "hash", startedAt: 40, completedAt: 50 },
      ],
    })
  })

  test("end() on a phase that was never open returns undefined rather than inventing one", () => {
    const timing = TurnTiming.make(() => 100)
    expect(timing.end("compaction")).toBeUndefined()
    expect(timing.snapshot().phases).toEqual([])
  })

  test("end() closes the NEWEST of several open records of one phase", () => {
    let now = 10
    const timing = TurnTiming.make(() => now)
    timing.start("capability-run")
    now = 20
    timing.start("capability-run")
    now = 35
    expect(timing.end("capability-run")).toEqual({ phase: "capability-run", startedAt: 20, completedAt: 35 })
    now = 50
    expect(timing.end("capability-run")).toEqual({ phase: "capability-run", startedAt: 10, completedAt: 50 })
  })
})

describe("discard — a stage that ran and did nothing", () => {
  // The owner's report: "Compacting the conversation" shown two messages into a fresh session, where
  // compactIfNeeded had measured the conversation and declined.
  test("withdraws the phase entirely, so the receipt cannot claim it happened", () => {
    const timing = TurnTiming.make(() => 100)
    timing.start("context-load")
    timing.end("context-load")
    timing.start("compaction")
    timing.discard("compaction")
    expect(timing.snapshot().phases.map((phase) => phase.phase)).toEqual(["context-load"])
  })

  // ⚠️ The part that could go wrong silently. `open` holds INDEXES into `phases`; removing an entry
  // shifts every later index down by one, so without the fixup a subsequent `end` closes the wrong
  // record and every phase after a discarded one is mis-timed.
  test("keeps later open phases pointing at their own records", () => {
    const timing = TurnTiming.make(() => 100)
    timing.start("compaction")
    timing.start("provider-setup")
    timing.discard("compaction")
    timing.end("provider-setup")
    const phases = timing.snapshot().phases
    expect(phases.map((phase) => phase.phase)).toEqual(["provider-setup"])
    expect(phases[0]!.completedAt).toBeDefined()
  })

  test("discarding an unopened phase is a no-op, not a corruption", () => {
    const timing = TurnTiming.make(() => 100)
    timing.start("context-load")
    timing.discard("compaction")
    timing.end("context-load")
    expect(timing.snapshot().phases.map((phase) => phase.phase)).toEqual(["context-load"])
  })
})

