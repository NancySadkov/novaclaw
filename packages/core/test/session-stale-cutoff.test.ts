import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { sweepStaleOnce } from "@novaclaw/core/session/boot-recovery"

/**
 * 🔴 NC-REL-010 — the stale cutoff has to MOVE, and it did not.
 *
 * `recoverStaleLeases` read `attempts.recoverStale(Date.now() - STALE_AFTER_MS)`, which evaluates
 * `Date.now()` once, while the Effect VALUE is being built. `Effect.repeat` then re-ran that same
 * value — and the same frozen number — through all seven passes. So the re-sweeps could only ever
 * find what the first sweep already could: an execution abandoned five seconds into the boot window
 * keeps a heartbeat newer than a cutoff that never advances, and is never recovered. That is exactly
 * the case `RESWEEP_PASSES` exists for, and its own comment calls it "a correctness bound, not a
 * tidy-up".
 *
 * A/B: hoist the clock read back out of the effect (`const cutoff = Date.now() - STALE_AFTER_MS`
 * outside `Effect.gen`) and the two cutoffs below become equal.
 */
describe("the stale-lease cutoff", () => {
  test("🔴 advances between passes — it is read when the sweep RUNS, not when it is built", async () => {
    const cutoffs: number[] = []
    const attempts = {
      recoverStale: (cutoff: number) =>
        Effect.sync(() => {
          cutoffs.push(cutoff)
          return [] as never[]
        }),
    }

    const sweep = sweepStaleOnce(attempts as never)
    await Effect.runPromise(sweep)
    // Real elapsed time, because the claim IS that a later run sees a later cutoff. A virtual clock
    // would prove the plumbing and not the property.
    await new Promise((resolve) => setTimeout(resolve, 25))
    await Effect.runPromise(sweep)

    expect(cutoffs).toHaveLength(2)
    expect(cutoffs[1]!).toBeGreaterThan(cutoffs[0]!)
  })

  test("the cutoff trails now by the stale window, not by zero", () => {
    // The control: a sweep that passed `Date.now()` itself would also "advance", and would reclassify
    // every live lease on its first pass.
    const cutoffs: number[] = []
    const attempts = {
      recoverStale: (cutoff: number) =>
        Effect.sync(() => {
          cutoffs.push(cutoff)
          return [] as never[]
        }),
    }
    const before = Date.now()
    Effect.runSync(sweepStaleOnce(attempts as never))
    expect(cutoffs[0]!).toBeLessThan(before)
  })
})
