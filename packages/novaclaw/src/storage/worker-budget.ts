export * as WorkerBudget from "./worker-budget"

import type { Reading } from "./worker-commit"
import os from "node:os"

const GIB = 1024 * 1024 * 1024

/**
 * The one fleet ceiling shared by observation and process admission.
 *
 * A third of host memory leaves the server, desktop, filesystem cache and ordinary user work outside
 * the worker fleet. The 2 GiB floor keeps nested parent/child progress possible on small hosts.
 */
export const fleetLimitBytes = (totalBytes = os.totalmem()): number => Math.max(2 * GIB, Math.floor(totalBytes / 3))

/**
 * WHO, IF ANYONE, SHOULD BE SHED — the whole decision, as one pure function.
 *
 * 🔴 **One mechanism, not two.** The EMERGENCY floor and
 * the test gate's kill-on-breach are the same shape with the same false-kill hazard, and must not be
 * designed twice. This is that shape, kept pure so both callers can share it and so the rule that
 * decides whether a process dies is readable without running anything.
 *
 * ⚠️ **The false-kill guard lives HERE, not in the caller.** A watchdog that sheds on a single sample
 * kills a worker for a spike it was already returning from — and the caller is exactly where such a
 * rule goes untested, because it needs a clock and a fleet to exercise. `streak` is passed in and the
 * "how many consecutive breaches" rule is applied in this function, where a test can state it in one
 * line.
 *
 * ⚠️ **Two ceilings, because they fail differently.** A single runaway worker is caught by
 * `perWorkerBytes`. N well-behaved workers that together exhaust the host are caught by `fleetBytes`
 * and by NOTHING else — every existing bound in this product is per-worker or per-parent, which is
 * why a fleet each individually "within limit" can still take the machine down.
 */

export interface Limits {
  /** What one worker may hold before it is the problem. */
  readonly perWorkerBytes: number
  /** What every live worker may hold TOGETHER. The bound nothing else in the product expresses. */
  readonly fleetBytes: number
  /** How many CONSECUTIVE breaching samples before shedding. Below this a breach only warns. */
  readonly consecutiveSamples: number
}

/** WHICH ceiling was crossed. Structured because the two lead to different conclusions — one
 *  runaway worker, or a fleet simply too large for this host — and because a log that carries only a
 *  sentence cannot be filtered on. */
export type Breach = "per-worker" | "fleet"

export type Decision =
  | { readonly action: "none" }
  | {
      readonly action: "warn"
      readonly breach: Breach
      readonly reason: string
      readonly limitBytes: number
      readonly pid?: number | undefined
    }
  | {
      readonly action: "shed"
      readonly breach: Breach
      readonly pid: number
      readonly reason: string
      readonly limitBytes: number
    }

const mib = (bytes: number) => Math.round(bytes / (1024 * 1024))

/** The heaviest worker — the one shedding actually buys room from. */
const heaviest = (readings: ReadonlyArray<Reading>): Reading | undefined =>
  readings.reduce<Reading | undefined>(
    (worst, r) => (worst === undefined || r.bytes > worst.bytes ? r : worst),
    undefined,
  )

/**
 * @param streak how many consecutive samples have ALREADY breached, before this one.
 */
export const decide = (input: {
  readonly readings: ReadonlyArray<Reading>
  readonly streak: number
  readonly limits: Limits
}): Decision => {
  const { readings, limits } = input
  if (readings.length === 0) return { action: "none" }

  const total = readings.reduce((sum, r) => sum + r.bytes, 0)
  const worst = heaviest(readings)
  const overWorker = worst !== undefined && worst.bytes > limits.perWorkerBytes ? worst : undefined
  const overFleet = total > limits.fleetBytes

  if (overWorker === undefined && !overFleet) return { action: "none" }

  // Name the SPECIFIC breach. "Memory is high" sends nobody anywhere; "this worker is at 3,100 MiB
  // against a 2,048 MiB ceiling" names the thing to look at, and the two breaches lead to different
  // conclusions — one runaway, or a fleet that is simply too large for this host.
  const breach: Breach = overWorker !== undefined ? "per-worker" : "fleet"
  const limitBytes = overWorker !== undefined ? limits.perWorkerBytes : limits.fleetBytes
  const reason =
    overWorker !== undefined
      ? `session worker ${overWorker.pid} holds ${mib(overWorker.bytes)} MiB against a ${mib(limits.perWorkerBytes)} MiB ceiling`
      : `${readings.length} session workers hold ${mib(total)} MiB together against a ${mib(limits.fleetBytes)} MiB ceiling`

  // `streak` counts samples BEFORE this one, so this sample is the (streak + 1)th in a row.
  if (input.streak + 1 < limits.consecutiveSamples)
    return { action: "warn", breach, reason, limitBytes, ...(overWorker === undefined ? {} : { pid: overWorker.pid }) }

  // Shed the heaviest either way: under a fleet breach it is the one that buys the most room, and
  // under a per-worker breach it IS the offender.
  const target = overWorker ?? worst
  if (target === undefined) return { action: "warn", breach, reason, limitBytes }
  return { action: "shed", breach, pid: target.pid, reason, limitBytes }
}
