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
export const RESERVATION_BYTES = 1280 * MIB

/** A parent blocked in `wait` must leave room for at least one child to run and release it. */
export const MIN_CONCURRENT_WORKERS = 2

/**
 * Turn the canonical fleet byte ceiling into an atomic process-admission capacity.
 *
 * The floor of two is structural, not a throughput preference: one worker may be the parent waiting
 * for its child. A one-permit fleet would deadlock the delegation primitive it is meant to protect.
 */
export const capacity = (fleetBytes = WorkerBudget.fleetLimitBytes()): number =>
  Math.max(MIN_CONCURRENT_WORKERS, Math.floor(fleetBytes / RESERVATION_BYTES))

export interface Input {
  readonly sessionID: string
  readonly priority: "interactive" | "batch"
}

export interface Snapshot {
  readonly capacity: number
  readonly active: readonly string[]
  readonly waitingInteractive: readonly string[]
  readonly waitingBatch: readonly string[]
}

interface Lease {
  readonly id: number
  readonly sessionID: string
}

interface Waiter {
  readonly input: Input
  readonly deferred: Deferred.Deferred<Lease>
}

/**
 * One process gate for one instance. Sessions queue before process creation, and the permit covers a
 * worker's complete life. Interactive sessions jump ahead of queued background work (without
 * preempting a process that is already running), preserving the scheduler's user-latency policy at
 * this earlier resource boundary too.
 */
export const make = (options?: { readonly fleetBytes?: number; readonly capacity?: number }) =>
  Effect.sync(() => {
    const limit = Math.max(1, options?.capacity ?? capacity(options?.fleetBytes))
    const active = new Map<number, Lease>()
    const waiting: Waiter[] = []
    let sequence = 0

    const nextIndex = () => {
      const interactive = waiting.findIndex((waiter) => waiter.input.priority === "interactive")
      return interactive >= 0 ? interactive : 0
    }

    const drain = () => {
      while (active.size < limit && waiting.length > 0) {
        const [waiter] = waiting.splice(nextIndex(), 1)
        const lease = { id: ++sequence, sessionID: waiter.input.sessionID }
        active.set(lease.id, lease)
        Deferred.doneUnsafe(waiter.deferred, Effect.succeed(lease))
      }
    }

    const acquire = (input: Input): Effect.Effect<Lease> =>
      Effect.suspend(() => {
        if (active.size < limit) {
          const lease = { id: ++sequence, sessionID: input.sessionID }
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

    return {
      capacity: limit,
      run: <A, E, R>(input: Input, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.uninterruptibleMask((restore) =>
          restore(acquire(input)).pipe(
            Effect.flatMap((lease) => restore(effect).pipe(Effect.ensuring(release(lease)))),
          ),
        ),
      snapshot: (): Snapshot => ({
        capacity: limit,
        active: [...active.values()].map((lease) => lease.sessionID),
        waitingInteractive: waiting
          .filter((waiter) => waiter.input.priority === "interactive")
          .map((waiter) => waiter.input.sessionID),
        waitingBatch: waiting
          .filter((waiter) => waiter.input.priority === "batch")
          .map((waiter) => waiter.input.sessionID),
      }),
    }
  })
