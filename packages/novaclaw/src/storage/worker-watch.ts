export * as WorkerWatch from "./worker-watch"

import { Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { Log } from "@novaclaw/schema/log"
import { SessionWorkerCommand } from "@/session-worker/command"
import { workerMemoryLimitBytes } from "@/session-worker/execution"
import { WorkerBudget } from "./worker-budget"
import { WorkerCommit } from "./worker-commit"
import { WorkerRegistry } from "./worker-registry"

/**
 * WATCH THE FLEET, AND SAY WHAT IT IS HOLDING. Nothing is shed — deliberately, for now.
 *
 * 🔴 **Warn-only is the whole point of this step.** The kill path
 * must not be armed before a warn-only tick has shown what a HEALTHY fleet looks like: a threshold
 * that has never seen the healthy distribution is the `threshold-that-fires-on-normal` defect, which
 * this codebase has already paid for once. So this samples, decides, and LOGS — and the `shed` arm
 * logs exactly like a warning until somebody has the distribution to arm it against.
 *
 * ⚠️ **The fleet ceiling below is PROVISIONAL and has never been validated against a real fleet.**
 * It is written down so the warnings have a line to cross, not because the number is defended. It is
 * a third of host memory; the per-worker ceiling beside it is NOT reinvented here — it comes from
 * `workerMemoryLimitBytes`, the same function the supervisor enforces, because two definitions of
 * "too big" is how a guard and the thing it guards drift apart.
 *
 * ⚠️ **An empty fleet costs nothing.** `WorkerCommit.sample` spawns no process for zero pids, so an
 * idle instance pays a `Map` read every tick and no more.
 */

/** How often to look. Slow on purpose: this is a trend, and a sample is a process on Windows. */
export const TICK = "5 seconds"

/**
 * ⚠️ Provisional. See the header — this is a line for warnings to cross, not a defended maximum.
 * A defended one has to come from a measured healthy distribution, which is what the warnings are
 * for gathering.
 */
export const fleetLimitBytes = WorkerBudget.fleetLimitBytes

/** How many consecutive breaching samples before this would shed, once shedding is armed. */
export const CONSECUTIVE = 3

export const observe = Effect.gen(function* () {
  const pids = WorkerRegistry.pids()
  if (pids.length === 0) return "idle" as const
  const sample = yield* Effect.promise(() => WorkerCommit.sample(pids))
  // ⚠️ An unmeasurable fleet is NOT a healthy one and must not be logged as a zero — the same rule
  // `pressure.ts` holds for the host. Say nothing rather than say "fine".
  if (sample.unavailable !== undefined) return "unmeasured" as const
  const total = sample.readings.reduce((sum, reading) => sum + reading.bytes, 0)
  yield* Log.event("resource.fleet.measure", {
    "resource.count": sample.readings.length,
    "resource.bytes": total,
    "resource.metric": sample.metric,
  })
  return { readings: sample.readings, total } as const
})

export const node = makeGlobalNode({
  name: "storage/worker-watch",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const limits = {
        // The SAME number the supervisor enforces per worker, not a second opinion about it.
        //
        // 🔴 **AND IT WAS NOT, UNTIL 2026-08-29.** This passed a hardcoded `".js"`, so it always took
        // the PACKAGED tier — while `execution.ts` enforces `workerMemoryLimitBytes(command.workerPath)`,
        // which gives a `.ts` entrypoint 3 GiB instead of ~2. In source mode the two disagreed by a
        // whole GiB, and a healthy worker at 2.15 GiB — 72 % of the limit actually enforced — logged
        // `resource.fleet.exceeded` every five seconds.
        // ⚠️ That is the `threshold-that-fires-on-normal` defect this file's own header names, and
        // the same-function-different-argument shape is exactly the drift the comment above promised
        // to prevent: calling one function is not sharing one number if the inputs differ.
        // ⚠️ Source mode is not a corner: every dev run, every test and every measurement sweep this
        // programme takes runs a `.ts` worker, so the warning was wrong in the only configuration
        // anybody observes.
        perWorkerBytes: workerMemoryLimitBytes(SessionWorkerCommand.current().workerPath),
        fleetBytes: fleetLimitBytes(),
        consecutiveSamples: CONSECUTIVE,
      }
      let streak = 0
      const tick = Effect.gen(function* () {
        const seen = yield* observe
        if (seen === "idle" || seen === "unmeasured") {
          // An idle or unmeasurable fleet RESETS the streak. Carrying it across a gap would let three
          // breaches minutes apart read as three in a row.
          streak = 0
          return
        }
        const decision = WorkerBudget.decide({ readings: seen.readings, streak, limits })
        if (decision.action === "none") {
          streak = 0
          return
        }
        streak += 1
        yield* Log.event("resource.fleet.exceeded", {
          "resource.breach": decision.breach,
          "resource.count": seen.readings.length,
          "resource.bytes": seen.total,
          "resource.limit": decision.limitBytes,
        })
      }).pipe(Effect.catchCause(() => Effect.void))
      // ⚠️ Forked into the layer's scope: a watcher that kept a shutdown waiting would be a guard
      // that costs the thing it protects.
      yield* Effect.forkScoped(tick.pipe(Effect.repeat(Schedule.spaced(TICK))))
    }),
  ),
  deps: [],
})
