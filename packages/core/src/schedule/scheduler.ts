export * as CalendarScheduler from "./scheduler"

// Calendar / cron-session creator (P2): the ticker's decision logic, isolated from boot wiring and the real
// session launch (P3) so it is deterministically unit-testable. `tick` runs one poll cycle: fire every DUE
// schedule exactly once (idempotent via the store's fire ledger), then roll it forward. Catch-up policy is
// fire-once — a schedule missed while the instance was down fires its due occurrence once and jumps to the
// next FUTURE occurrence (advance computes strictly after `now`); missed intermediate occurrences are not
// replayed (no thundering herd). A launch failure is isolated (never wedges the loop), recorded as `error`,
// and the schedule still advances.

import { Effect } from "effect"
import type { Database } from "../database/database"
import type { EpochMillis } from "./recurrence"
import { CalendarStore } from "./store"

export interface LaunchInput {
  readonly schedule: CalendarStore.Schedule
  readonly occurrenceMillis: number
  readonly firedAt: number
}

/**
 * Create + start the session for a fired schedule. Returns the new session id, or null on no-session.
 * May fail — `tick` absorbs every cause so a bad launch never wedges the poll loop.
 */
export type Launch = (input: LaunchInput) => Effect.Effect<string | null, unknown>

export interface TickResult {
  /** Occurrences that launched a session this cycle. */
  readonly fired: number
  /** Due occurrences that were already claimed by a prior cycle, or whose launch produced no session. */
  readonly skipped: number
}

type Db = Database.Interface["db"]

/** One poll cycle. `now` is injected (the boot loop passes `yield* Clock.currentTimeMillis`). */
export const tick = (db: Db, launch: Launch, now: EpochMillis): Effect.Effect<TickResult> =>
  Effect.gen(function* () {
    const due = yield* CalendarStore.due(db, now)
    let fired = 0
    let skipped = 0
    for (const schedule of due) {
      const occurrence = schedule.nextFireAt
      if (occurrence === null) continue // due() already excludes nulls; defensive.

      // Claim the occurrence BEFORE doing any work — the idempotency guard against overlapping
      // ticks / a restart mid-fire. A losing claim means another cycle already handled it.
      const claimed = yield* CalendarStore.recordFire(db, {
        scheduleId: schedule.id,
        occurrenceMillis: occurrence,
        firedAt: now,
        status: "spawned",
      })
      if (claimed) {
        const sessionId = yield* launch({ schedule, occurrenceMillis: occurrence, firedAt: now }).pipe(
          // A bad launch must never kill the poll loop — record it and move on.
          Effect.catchCause(() => Effect.succeed(null)),
        )
        yield* CalendarStore.setFireOutcome(db, {
          scheduleId: schedule.id,
          occurrenceMillis: occurrence,
          sessionId,
          status: sessionId ? "spawned" : "error",
        })
        if (sessionId !== null) fired++
        else skipped++
      } else {
        skipped++
      }

      // Roll forward regardless so this occurrence is never re-returned by due().
      yield* CalendarStore.advance(db, schedule.id, now)
    }
    return { fired, skipped }
  })
