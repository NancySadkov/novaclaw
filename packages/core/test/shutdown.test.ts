import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Shutdown } from "@novaclaw/core/shutdown"
import { testEffect } from "./lib/effect"

// `Shutdown` needs no services — it takes its tasks as arguments — so the harness gets an empty
// layer rather than a service graph. `it.live` matters for the timeout cases: a TestClock would
// never advance the real deadline these assert on.
const it = testEffect(Layer.empty)

describe("settling everything inside one deadline", () => {
  it.effect("reports every task settled when they all finish", () =>
    Effect.gen(function* () {
      const report = yield* Shutdown.settleAll(
        [
          { name: "sessions", settle: Effect.void },
          { name: "terminals", settle: Effect.void },
        ],
        "1 second",
      )
      expect(report.settledAll).toBe(true)
      expect(report.forced).toEqual([])
      expect(report.results.map((r) => r.outcome)).toEqual(["settled", "settled"])
    }),
  )

  /**
   * ⚠️ A hung subsystem must not hold the process open. Without a deadline over the set, one stuck
   * terminal turns "quit" into a hang, which is the failure users resolve with a force-kill — the
   * exact thing this is meant to prevent.
   */
  it.live("names a task that never settles, and still returns", () =>
    Effect.gen(function* () {
      const report = yield* Shutdown.settleAll(
        [
          { name: "sessions", settle: Effect.void },
          { name: "model-worker", settle: Effect.never },
        ],
        "60 millis",
      )
      expect(report.settledAll).toBe(false)
      expect(report.forced).toEqual(["model-worker"])
      expect(report.results.find((r) => r.name === "model-worker")?.outcome).toBe("timed-out")
      // The siblings still settled — a stuck subsystem must not cost the ones that would have flushed.
      expect(report.results.find((r) => r.name === "sessions")?.outcome).toBe("settled")
    }),
  )

  /**
   * ⚠️ THE property that makes this worth a module. Shutdown is where "abort the rest on first
   * error" is most expensive: the subsystems queued after the failure are exactly the ones still
   * holding unflushed state. A failure is recorded, never propagated.
   */
  it.effect("a failing task does not cancel its siblings", () =>
    Effect.gen(function* () {
      const report = yield* Shutdown.settleAll(
        [
          { name: "downloads", settle: Effect.fail(new Error("disk went away")) },
          { name: "terminals", settle: Effect.void },
          { name: "sessions", settle: Effect.void },
        ],
        "1 second",
      )
      expect(report.results.find((r) => r.name === "downloads")?.outcome).toBe("failed")
      expect(report.results.find((r) => r.name === "downloads")?.detail).toContain("disk went away")
      // Both siblings ran. If the first failure had propagated, these would be absent.
      expect(
        report.results
          .filter((r) => r.outcome === "settled")
          .map((r) => r.name)
          .toSorted(),
      ).toEqual(["sessions", "terminals"])
      expect(report.forced).toEqual(["downloads"])
    }),
  )

  it.effect("a defect is recorded like a failure rather than escaping", () =>
    Effect.gen(function* () {
      const report = yield* Shutdown.settleAll(
        [{ name: "terminals", settle: Effect.sync(() => JSON.parse("{{ not json") as unknown) }],
        "1 second",
      )
      expect(report.results[0]?.outcome).toBe("failed")
      expect(report.forced).toEqual(["terminals"])
    }),
  )

  it.effect("a task that legitimately returns undefined is not read as a timeout", () =>
    Effect.gen(function* () {
      // The timeout sentinel is a private Symbol precisely so this cannot be confused.
      const report = yield* Shutdown.settleAll([{ name: "sessions", settle: Effect.succeed(undefined) }], "1 second")
      expect(report.results[0]?.outcome).toBe("settled")
    }),
  )

  it.effect("nothing to settle is not a forced shutdown", () =>
    Effect.gen(function* () {
      const report = yield* Shutdown.settleAll([], "1 second")
      expect(report.settledAll).toBe(true)
      expect(report.forced).toEqual([])
    }),
  )

  it.effect("the summary line names what was forced, and says nothing alarming when nothing was", () =>
    Effect.gen(function* () {
      const clean = yield* Shutdown.settleAll([{ name: "sessions", settle: Effect.void }], "1 second")
      expect(Shutdown.describe(clean)).toContain("Everything settled")
      expect(Shutdown.describe(clean)).not.toContain("Forced")
    }),
  )

  it.live("the summary names every forced subsystem", () =>
    Effect.gen(function* () {
      const report = yield* Shutdown.settleAll(
        [
          { name: "model-worker", settle: Effect.never },
          { name: "downloads", settle: Effect.fail(new Error("nope")) },
        ],
        "60 millis",
      )
      const line = Shutdown.describe(report)
      expect(line).toContain("model-worker")
      expect(line).toContain("downloads")
    }),
  )
})
