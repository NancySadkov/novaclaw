import { describe, expect, test } from "bun:test"
import {
  attemptLabel,
  currentPhase,
  elapsedMs,
  LONG_STAGE_MS,
  longStageNote,
  phaseLabel,
  phaseLabels,
  RETIRED_PHASES,
  seconds,
  turnOutcome,
  type TurnTiming,
} from "./turn-receipt"

describe("turn receipt", () => {
  test("🔴 no two LIVE phases share a label — a repeat in the receipt must mean a real repeat", () => {
    // Three unrelated stretches of runner/llm.ts once all recorded a phase named `prepare`, so a
    // finished turn listed "Preparing your prompt" three times and read as a stutter or a loop. The
    // same thing happened to `snapshot`: a turn takes a baseline AND a comparison, and both said
    // "Checking your files". Distinct labels are what make a repeated line trustworthy — it now
    // means the work actually repeated.
    //
    // Retired phases are excluded because they cannot co-occur with their replacements in one turn;
    // including them would force a stored turn's wording to change to satisfy a rule about new ones.
    const live = Object.entries(phaseLabels).filter(([phase]) => !RETIRED_PHASES.has(phase))
    const labels = live.map(([, label]) => label)
    expect(new Set(labels).size, `duplicate labels in ${JSON.stringify(labels)}`).toBe(labels.length)
    // …and the exclusion is not a loophole: every retired name must still HAVE a label, or an old
    // turn renders `undefined` where a phase name should be.
    for (const phase of RETIRED_PHASES) expect(Object.keys(phaseLabels), phase).toContain(phase)
  })

  test("the two snapshots a turn takes are named apart", () => {
    expect(phaseLabel("snapshot-before")).toBe("Checking your files")
    expect(phaseLabel("snapshot-after")).toBe("Checking what changed")
    expect(phaseLabel("snapshot")).toBe("Checking your files")
  })

  test("the three phases that replaced `prepare` each name their own work", () => {
    expect(phaseLabel("context-load")).toBe("Gathering the conversation")
    expect(phaseLabel("request-build")).toBe("Building the request")
    expect(phaseLabel("context-fit")).toBe("Fitting the context window")
    // Retired, not removed: turns stored before the split still carry it, and a missing label would
    // render `undefined` in their receipt.
    expect(phaseLabel("prepare")).toBe("Preparing your prompt")
  })

  test("uses friendly labels and stable seconds", () => {
    expect(phaseLabel("memory-search")).toBe("Recalling")
    expect(phaseLabel("provider-prefill")).toBe("Waiting for the model")
    expect(phaseLabel("capability-queue")).toBe("Waiting for a service")
    expect(phaseLabel("capability-load")).toBe("Starting a service")
    expect(phaseLabel("capability-run")).toBe("Running a service")
    expect(seconds(elapsedMs(100, 1349, 9999))).toBe("1.2s")
    expect(seconds(elapsedMs(100, undefined, 650))).toBe("0.6s")
  })

  test("normalizes every supported timestamp carrier and never formats NaN", () => {
    const start = Date.UTC(2026, 8, 8, 10, 0, 0)
    expect(seconds(elapsedMs({ epochMillis: start }, new Date(start + 1_250), start + 9_000))).toBe("1.3s")
    expect(seconds(elapsedMs(new Date(start).toISOString(), start + 500, start + 9_000))).toBe("0.5s")
    expect(elapsedMs("not-a-time", start + 500, start + 9_000)).toBeUndefined()
    expect(seconds(Number.NaN)).toBeUndefined()
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

  test("says nothing about a stage until it has actually run long", () => {
    expect(longStageNote("provider-prefill", 0)).toBeUndefined()
    expect(longStageNote("provider-prefill", LONG_STAGE_MS - 1)).toBeUndefined()
    expect(longStageNote("provider-prefill", LONG_STAGE_MS)).toBeTruthy()
    expect(longStageNote("provider-prefill", LONG_STAGE_MS)).toBe(
      "The agent is working on the request. Large images and files can take time.",
    )
  })

  test("explains a long stage with a cause, and stays silent where it has none", () => {
    // Each note must name something real the user can wait out or act on. A phase we cannot
    // honestly explain gets nothing — an empty reassurance is what this replaces.
    expect(longStageNote("scheduler-wait", 30_000)).toContain("Another session")
    expect(longStageNote("capability-load", 30_000)).toContain("first time")
    expect(longStageNote("compaction", 30_000)).toBeUndefined()
    expect(longStageNote("generation", 30_000)).toBeUndefined()
    expect(longStageNote("memory-rerank", 30_000)).toBeUndefined()
    // Observed live 2026-08-11: "Checking what changed…" sat at 10.6 s, and this map did not cover
    // it. A unit test cannot find that — it is here so a rename cannot quietly drop the phase that
    // was actually seen to be slow. The note hedges because follow-up measurement found every
    // primitive at 85–160 ms and never reproduced the 10.6 s, so its cause is not established.
    expect(longStageNote("snapshot-after", 30_000)).toContain("normally quick")
    expect(longStageNote("snapshot-before", 30_000)).toContain("last snapshot")
  })

  test("leaves compaction progress to the durable transcript row", () => {
    expect(longStageNote("compaction", 30_000)).toBeUndefined()
  })

  test("no note promises progress or an ending it cannot see", () => {
    const forbidden = /almost|nearly|soon|please wait|shortly|hang on/i
    const phases = Object.keys(phaseLabels) as (keyof typeof phaseLabels)[]
    for (const phase of phases) {
      const note = longStageNote(phase, 60_000)
      if (note) expect(note).not.toMatch(forbidden)
    }
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

describe("turnOutcome — the stand-in when a settled turn wrote no prose", () => {
  // The case that unblocks the fold: 57% of tool-bearing turns end here.
  test("names the step count and says plainly that no reply was written", () => {
    expect(turnOutcome({ toolCount: 3 })).toBe("Ran 3 steps. The model ended here without writing a reply.")
    expect(turnOutcome({ toolCount: 1 })).toBe("Ran 1 step. The model ended here without writing a reply.")
  })

  // ⚠️ `exit` ENDS the drain by design (llm.ts), so calling it "without writing a reply" would
  // describe a fault that is not one — ruling 2, on the surface a user reads.
  test("a turn that ended on exit reads as finished, not as stopped short", () => {
    expect(turnOutcome({ toolCount: 2, lastToolName: "exit" })).toBe("Finished after 2 steps.")
  })

  // No work means no fold, so there is nothing to stand in for — and a receipt that appeared over a
  // plain conversational answer would be the "Done box containing nothing" the Turn doc rules out.
  test("says nothing when the turn ran no tools", () => {
    expect(turnOutcome({ toolCount: 0 })).toBeUndefined()
    expect(turnOutcome({ toolCount: -1 })).toBeUndefined()
  })

  // It may only state what the transcript knows. No cause, no blame, no guess.
  test("never speculates about WHY", () => {
    const line = turnOutcome({ toolCount: 4 })!
    for (const forbidden of ["error", "failed", "crash", "stuck", "probably", "may have"])
      expect(line.toLowerCase()).not.toContain(forbidden)
  })
})
