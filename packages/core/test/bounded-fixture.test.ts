import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { runBounded } from "./fixture/bounded"

// The bound S2's rewritten runner suite will run every case under. These tests are the negative
// control the ruling asks for: "a deliberately spinning case must FAIL, not hang." A bound nobody has
// watched fail is a bound nobody knows works — which is exactly how the old suite came to be skipped.

describe("runBounded", () => {
  test("an ordinary effect passes its value through untouched", async () => {
    expect(await runBounded(Effect.succeed(42), { ms: 1_000, label: "plain value" })).toBe(42)
  })

  test("a failure surfaces as a rejection, not as a timeout", async () => {
    // A bound that turned every failure into "timed out" would make real defects unreadable.
    const boom = Effect.fail(new Error("the drain refused"))
    await expect(runBounded(boom, { ms: 1_000, label: "should not be reported" })).rejects.toThrow()
  })

  test("🔴 a cooperative spin FAILS BY NAME instead of hanging", async () => {
    // THE negative control. Without a bound this never returns and the suite dies behind bun's
    // anonymous per-test timeout — the exact failure mode that took session-runner.test.ts dark.
    const spin = Effect.gen(function* () {
      for (;;) yield* Effect.yieldNow
    })
    const started = Date.now()
    await expect(runBounded(spin, { ms: 300, label: "steer loop never settled" })).rejects.toThrow(
      /steer loop never settled/,
    )
    // Bounded in REAL time: it must not have waited out bun's 15 s per-test timeout to get here.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("🔴 the bound still fires UNDER TestContext — the case that hangs an Effect-time bound", async () => {
    // Measured 2026-08-05: a bound expressed in Effect time never fires here, because TestContext's
    // clock does not advance on its own; Effect warns about exactly this. The whole reason runBounded
    // uses a real setTimeout is to keep working in the environment the runner suite actually uses.
    const spin = Effect.gen(function* () {
      for (;;) yield* Effect.yieldNow
    }).pipe(Effect.provide(Layer.mergeAll(TestClock.layer())))
    await expect(runBounded(spin, { ms: 300, label: "spin under a virtual clock" })).rejects.toThrow(
      /spin under a virtual clock/,
    )
  })

  test("the runaway is interrupted, not merely abandoned", async () => {
    // A bound that reports and walks away moves the wedge into the next test, where it gets blamed on
    // innocent code. The spin increments a counter; after the bound fires and we wait, it must stop.
    let ticks = 0
    const spin = Effect.gen(function* () {
      for (;;) {
        ticks += 1
        yield* Effect.yieldNow
      }
    })
    await expect(runBounded(spin, { ms: 200, label: "counting spin" })).rejects.toThrow()
    const atFailure = ticks
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(ticks, "the fiber kept running after its bound fired").toBe(atFailure)
  })
})
