export * as SessionWorkerAdmission from "./admission"

import { Deferred, Effect } from "effect"
import { WorkerBudget } from "@/storage/worker-budget"

const MIB = 1024 * 1024

/**
 * Reserve more than the 0.84–0.90 GiB per source worker observed in the 2026-08-31 live fleet, so a
 * normal fluctuation does not put the watcher directly on its ceiling.
 *
 * This is an admission reservation, not a per-worker kill limit. The two answer different questions:
 * this one budgets a healthy fleet before processes exist; the supervisor limit contains one worker
 * that grows after admission.
 */
export const SOURCE_RESERVATION_BYTES = 1280 * MIB

/** Packaged Node workers measured 163–168 MiB private / 197–211 MiB working set on the owner's
 * 2026-09-09 fleet. Three times that observed footprint leaves substantial headroom without
 * pretending every packaged worker carries Bun's source compiler and module graph. */
export const PACKAGED_RESERVATION_BYTES = 640 * MIB

export const reservationBytes = (workerPath: string) =>
  workerPath.endsWith(".ts") ? SOURCE_RESERVATION_BYTES : PACKAGED_RESERVATION_BYTES

/** A parent blocked in `wait` must leave room for at least one child to run and release it. */
export const MIN_CONCURRENT_WORKERS = 2

/**
 * Turn the canonical fleet byte ceiling into an atomic process-admission capacity.
 *
 * The floor of two is structural, not a throughput preference: one worker may be the parent waiting
 * for its child. A one-permit fleet would deadlock the delegation primitive it is meant to protect.
 */
export const capacity = (
  fleetBytes = WorkerBudget.fleetLimitBytes(),
  reservedBytes = PACKAGED_RESERVATION_BYTES,
): number => Math.max(MIN_CONCURRENT_WORKERS, Math.floor(fleetBytes / reservedBytes))

export interface Input {
  readonly sessionID: string
  readonly priority: "governing" | "interactive" | "batch"
}

export interface Snapshot {
  readonly capacity: number
  readonly active: readonly string[]
  readonly waitingGoverning: readonly string[]
  readonly waitingInteractive: readonly string[]
  readonly waitingBatch: readonly string[]
}

interface Lease {
  readonly id: number
  readonly sessionID: string
  readonly priority: Input["priority"]
}

interface Waiter {
  readonly input: Input
  readonly deferred: Deferred.Deferred<Lease>
}

/**
 * One process gate for one instance. Sessions queue before process creation, and the permit covers a
 * worker's complete life. Nova's governing work jumps ahead of an opened interactive chat, which
 * jumps ahead of background work (without preempting a process that is already running). This keeps
 * the control plane able to contain runaway delegation while preserving user latency at this earlier
 * resource boundary too.
 */
export const make = (options?: {
  readonly fleetBytes?: number
  readonly capacity?: number
  readonly reservationBytes?: number
}) =>
  Effect.sync(() => {
    const limit = Math.max(1, options?.capacity ?? capacity(options?.fleetBytes, options?.reservationBytes))
    // Small/test fleets cannot reserve two different control lanes without preventing useful work.
    // At normal production capacity, background work may fill every device lane but never the two
    // host lanes that let the opened chat and Nova reach that device scheduler.
    const reserveGoverning = limit >= 4 ? 1 : 0
    const reserveInteractive = limit >= 4 ? 1 : 0
    const batchLimit = limit - reserveGoverning - reserveInteractive
    const nonGoverningLimit = limit - reserveGoverning
    const active = new Map<number, Lease>()
    const waiting: Waiter[] = []
    let sequence = 0

    const count = (priority: Input["priority"]) =>
      [...active.values()].filter((lease) => lease.priority === priority).length

    const canAdmit = (input: Input) => {
      if (active.size >= limit) return false
      if (input.priority === "governing") return true
      if (active.size - count("governing") >= nonGoverningLimit) return false
      if (input.priority === "interactive") return true
      return count("batch") < batchLimit
    }

    const nextIndex = () => {
      for (const priority of ["governing", "interactive", "batch"] as const) {
        const index = waiting.findIndex((waiter) => waiter.input.priority === priority && canAdmit(waiter.input))
        if (index >= 0) return index
      }
      return -1
    }

    const drain = () => {
      while (active.size < limit && waiting.length > 0) {
        const index = nextIndex()
        if (index < 0) return
        const [waiter] = waiting.splice(index, 1)
        const lease = { id: ++sequence, sessionID: waiter.input.sessionID, priority: waiter.input.priority }
        active.set(lease.id, lease)
        Deferred.doneUnsafe(waiter.deferred, Effect.succeed(lease))
      }
    }

    const acquire = (input: Input): Effect.Effect<Lease> =>
      Effect.suspend(() => {
        if (canAdmit(input)) {
          const lease = { id: ++sequence, sessionID: input.sessionID, priority: input.priority }
          active.set(lease.id, lease)
          return Effect.succeed(lease)
        }
        const waiter: Waiter = { input, deferred: Deferred.makeUnsafe<Lease>() }
        waiting.push(waiter)
        return Deferred.await(waiter.deferred).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              const index = waiting.indexOf(waiter)
              if (index >= 0) waiting.splice(index, 1)
            }),
          ),
        )
      })

    const release = (lease: Lease) =>
      Effect.sync(() => {
        if (!active.delete(lease.id)) return
        drain()
      })

    /** Reclassify a session when a human opens or leaves its chat. An already-running session must
     * change class too: otherwise opening one background worker never releases its reserved batch
     * share and the queue continues to apply yesterday's priority decision. */
    const reprioritize = (sessionID: string, priority: Input["priority"]) => {
      for (const [id, lease] of active)
        if (lease.sessionID === sessionID && lease.priority !== priority) active.set(id, { ...lease, priority })
      for (let index = 0; index < waiting.length; index++) {
        const waiter = waiting[index]!
        if (waiter.input.sessionID !== sessionID || waiter.input.priority === priority) continue
        waiting[index] = { ...waiter, input: { ...waiter.input, priority } }
      }
      drain()
    }

    return {
      capacity: limit,
      reprioritize,
      run: <A, E, R>(input: Input, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.uninterruptibleMask((restore) =>
          restore(acquire(input)).pipe(
            Effect.flatMap((lease) => restore(effect).pipe(Effect.ensuring(release(lease)))),
          ),
        ),
      snapshot: (): Snapshot => ({
        capacity: limit,
        active: [...active.values()].map((lease) => lease.sessionID),
        waitingGoverning: waiting
          .filter((waiter) => waiter.input.priority === "governing")
          .map((waiter) => waiter.input.sessionID),
        waitingInteractive: waiting
          .filter((waiter) => waiter.input.priority === "interactive")
          .map((waiter) => waiter.input.sessionID),
        waitingBatch: waiting
          .filter((waiter) => waiter.input.priority === "batch")
          .map((waiter) => waiter.input.sessionID),
      }),
    }
  })
