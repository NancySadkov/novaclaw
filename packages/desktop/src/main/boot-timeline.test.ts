import { describe, expect, test } from "bun:test"
import { BOOT_PHASES, createBootTimeline, formatSummary, type ProcessMemory } from "./boot-timeline"

const memory = (workingSetBytes: number): ProcessMemory[] => [{ kind: "browser", pid: 1, workingSetBytes }]

/** A clock the test drives, so nothing here depends on how fast the machine running it is. */
const at = (times: number[]) => {
  let index = 0
  return () => times[Math.min(index++, times.length - 1)]!
}

describe("boot timeline", () => {
  test("elapsed is measured from PROCESS START, not from the first mark", () => {
    // The defect this prevents: in a packaged build the main script runs long after the process
    // exists — Electron's own startup, the asar mount, V8's snapshot. Anchoring at module load would
    // report a fast boot by excluding the slow part, which looks exactly like a real measurement.
    const timeline = createBootTimeline({
      now: at([1_400, 1_900]),
      processStartedAt: 1_000,
      memory: () => memory(100),
    })
    expect(timeline.mark("electron-ready")?.elapsedMs).toBe(400)
    expect(timeline.mark("sidecar-health")?.elapsedMs).toBe(900)
  })

  test("🔴 a repeated phase is DROPPED, never overwritten", () => {
    // `first-chat-token` fires once per assistant reply and `renderer-interactive` again on every
    // reload. Letting a later one win turns "time to first token" into "time to the most recent
    // token" — still a plausible-looking startup number, and wrong by an unbounded amount.
    const timeline = createBootTimeline({
      now: at([1_100, 9_999_999]),
      processStartedAt: 1_000,
      memory: () => memory(100),
    })
    expect(timeline.mark("first-chat-token")?.elapsedMs).toBe(100)
    expect(timeline.mark("first-chat-token")).toBeUndefined()
    expect(timeline.summary().marks).toHaveLength(1)
    expect(timeline.summary().marks[0]!.elapsedMs).toBe(100)
  })

  test("🔴 a phase that never happened is MISSING, not zero", () => {
    // A boot that never reached first-token and one that reached it instantly are opposite outcomes.
    // Spelled the same way, a series averages them into a number describing neither.
    const timeline = createBootTimeline({ now: at([1_050]), processStartedAt: 1_000, memory: () => [] })
    timeline.mark("electron-ready")
    const summary = timeline.summary()
    expect(summary.missing).toEqual(BOOT_PHASES.filter((phase) => phase !== "electron-ready"))
    expect(summary.deltasMs["first-chat-token"]).toBeUndefined()
    expect(formatSummary(summary)).toContain("missing=")
  })

  test("deltas follow the order marks HAPPENED, so a reordered boot has no negative slice", () => {
    // Ordering by the vocabulary rather than by the clock would produce a negative delta and report
    // it as though time had run backwards.
    const timeline = createBootTimeline({
      now: at([1_100, 1_300, 1_800]),
      processStartedAt: 1_000,
      memory: () => [],
    })
    timeline.mark("electron-ready")
    timeline.mark("window-shown")
    timeline.mark("sidecar-health")
    const summary = timeline.summary()
    expect(summary.marks.map((mark) => mark.phase)).toEqual(["electron-ready", "window-shown", "sidecar-health"])
    expect(summary.deltasMs["window-shown"]).toBe(200)
    expect(summary.deltasMs["sidecar-health"]).toBe(500)
    expect(Object.values(summary.deltasMs).every((value) => value >= 0)).toBe(true)
  })

  test("🔴 a delta is NEVER computed across concurrent tracks", () => {
    // The defect this pins, and it was PUBLISHED before it was caught: the renderer and the sidecar
    // run concurrently, so `renderer-interactive → sidecar-spawned` is the gap between two unrelated
    // events. Reported as a delta it read as "the sidecar spawn took 1,035 ms — 45% of the boot",
    // which measured neither of them and looked exactly like a measurement.
    const timeline = createBootTimeline({
      now: at([1_100, 1_200, 1_500, 2_000]),
      processStartedAt: 1_000,
      memory: () => [],
    })
    timeline.mark("window-shown") // main, 100
    timeline.mark("sidecar-start") // main, 200
    timeline.mark("renderer-interactive") // renderer, 500 — interleaved in TIME, unrelated in cause
    timeline.mark("sidecar-spawned") // main, 1000
    const summary = timeline.summary()
    // Measured against its own track's predecessor (sidecar-start at 200), NOT against the renderer
    // mark that happens to sit between them.
    expect(summary.deltasMs["sidecar-spawned"]).toBe(800)
    expect(summary.deltasMs["sidecar-start"]).toBe(100)
    // The first mark of a track has no delta at all — `elapsedMs` already says how long after
    // process start it happened, and a delta from zero would be that same fact spelled worse.
    expect(summary.deltasMs["renderer-interactive"]).toBeUndefined()
  })

  test("a clock that reads before process start clamps to 0 rather than going negative", () => {
    // `processStartedAt` comes from the OS and `now` from the runtime; they are not guaranteed to
    // agree to the millisecond, and a negative elapsed would poison every delta after it.
    const timeline = createBootTimeline({ now: at([900]), processStartedAt: 1_000, memory: () => [] })
    expect(timeline.mark("electron-ready")?.elapsedMs).toBe(0)
  })

  test("memory is read once PER MARK, so a phase can be blamed for what it allocated", () => {
    // Reading it once and reusing the snapshot would make every phase report the same number, which
    // is the failure that looks most like a working instrument: plausible values, no signal at all.
    let calls = 0
    const timeline = createBootTimeline({
      now: at([1_100, 1_200]),
      processStartedAt: 1_000,
      memory: () => {
        calls += 1
        return memory(calls * 1_000_000)
      },
    })
    timeline.mark("electron-ready")
    timeline.mark("window-shown")
    expect(calls).toBe(2)
    expect(timeline.marks().map((mark) => mark.memory[0]!.workingSetBytes)).toEqual([1_000_000, 2_000_000])
  })
})
