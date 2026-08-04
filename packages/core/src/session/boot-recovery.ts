export * as SessionBootRecovery from "./boot-recovery"

import { Duration, Effect, Schedule } from "effect"
import { Log } from "@novaclaw/schema/log"
import type { Database } from "../database/database"
import { EFFECTIVE_CONFIG_DEFAULTS, resolveSessionConfig } from "./config-resolve"
import type { SessionExecution } from "./execution"
import type { SessionExecutionAttempt } from "./execution-attempt"
import { SessionInput } from "./input"
import type { SessionSchema } from "./schema"
import type { SessionStore } from "./store"

/**
 * **What a dead host leaves behind, and who re-drives it.**
 *
 * Two kinds of session work are DURABLE while the thing that would run them is IN-MEMORY, so a
 * process restart — a crash, an autoupdate, an ordinary quit — strands both:
 *
 *   1. **A lease left mid-flight.** `session_execution` rows sit in `starting`/`busy`/`recovering`
 *      with a heartbeat that stopped. Only `recoverStale` reclassifies them into the interrupted /
 *      paused states the recovery UI reads, and until it runs the session reports *busy* forever
 *      for a turn no process is running.
 *   2. **Queued input nobody will promote.** `session_input` rows with `promoted_seq IS NULL` are
 *      already-accepted prompts. The coordinator that promotes them lives in
 *      `SessionRunCoordinator` — a `Map` — and nothing polls, subscribes or times. So a prompt
 *      typed while the agent was mid-turn was **silently dropped by the restart**.
 *
 * ⚠️ **This lives here, and not in an executor, because there are TWO executors.** Production runs
 * `SessionExecutionWorker` (one disposable child per drain); `SessionExecutionLocal` is core's
 * in-process implementation. `recoverStale` used to be forked inside the *local* one — which, since
 * that layer has no production caller, means stale-host recovery ran **in tests only** while the
 * shipped server never reclassified a single abandoned lease. Owning both sweeps at the seam where
 * an instance ADOPTS an executor (`SessionV2`'s layer, beside the wake relay's `attach`) is what
 * makes them implementation-independent — and is why neither may move back down.
 */

/** How stale a lease heartbeat must be before its owner is presumed dead. */
export const STALE_AFTER_MS = 30_000

/**
 * A replacement host can start before the dead one's last heartbeat is old enough to classify, so
 * one sweep at boot is not enough — keep sweeping.
 */
const RESWEEP_INTERVAL = Duration.seconds(10)

/**
 * Reclassify leases whose owner stopped heartbeating. Repeats forever in the caller's scope.
 *
 * `recoverStale` is itself transactional and fenced on `(session_id, attempt_id, generation)`, so a
 * second host sweeping the same rows cannot double-count a failure.
 */
export const recoverStaleLeases = (attempts: SessionExecutionAttempt.Interface) =>
  attempts.recoverStale(Date.now() - STALE_AFTER_MS).pipe(
    // Only a sweep that FOUND something is worth a line: this repeats every ten seconds for the
    // life of the instance, and an unconditional record would be 8,640 "recovered 0" lines a day.
    Effect.flatMap((recovered) =>
      recovered.length === 0
        ? Effect.void
        : Log.event("session.lease.stale.recovered", { "session.recovered": recovered.length }),
    ),
    Effect.repeat(Schedule.spaced(RESWEEP_INTERVAL)),
  )

/**
 * Hand every session holding un-promoted queued input back to the executor, exactly as the admission
 * that created it would have done had the process lived.
 *
 * Runs ONCE — the durable/in-memory split it repairs exists only across a restart, and every later
 * admission wakes on its own (`SessionV2.prompt`, `command`, `spawn`, `switchResponder`).
 *
 * ⚠️ **A session under operator control is deliberately skipped.** B10 hands the conversation to a
 * human and Nova stops answering: `SessionRunner.run` resolves the same config and returns before
 * any turn, so waking one buys a worker process that spawns only to discover it has nothing to do —
 * on every boot, for as long as the handoff lasts. Control coming back is itself a wake
 * (`switchResponder` → `execution.wake`), which is the event that should start that turn.
 * The check FAILS OPEN: if the config walk cannot answer, the session is woken. Skipping on an
 * unreadable config would silently re-create the very defect this sweep exists to fix.
 */
export const wakeAbandonedInput = Effect.fn("SessionBootRecovery.wakeAbandonedInput")(function* (input: {
  readonly db: Database.Interface["db"]
  readonly store: SessionStore.Interface
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}) {
  const sessions = yield* SessionInput.sessionsWithPendingQueue(input.db)
  if (sessions.length === 0) return 0
  let woken = 0
  let handedOff = 0
  for (const sessionID of sessions) {
    const responder = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, (id) =>
      input.store.get(id as SessionSchema.ID),
    ).pipe(
      Effect.map((config) => config.responder),
      // ⚠️ `catchCause`, not `orElseSucceed`: `SessionStore.get` is `orDie`, so its error channel is
      // `never` and a real walk failure arrives as a DEFECT. Handling only the typed error would
      // leave this arm dead in production and take the whole sweep down with the first bad row.
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (responder === "operator") {
      handedOff++
      continue
    }
    yield* input.wake(sessionID)
    woken++
  }
  yield* Log.event("session.input.abandoned.resumed", {
    "session.resumed": woken,
    "session.handedOff": handedOff,
  })
  return woken
})

/**
 * Start both sweeps in the caller's scope. Forked, and each arm is independently non-fatal: boot is
 * exactly where the self-healing law is void (`todo/startup.md`), so a recovery that cannot run must
 * degrade rather than take the instance down with it.
 */
export const start = (input: {
  readonly db: Database.Interface["db"]
  readonly store: SessionStore.Interface
  readonly attempts: SessionExecutionAttempt.Interface
  readonly execution: SessionExecution.Interface
}) =>
  Effect.gen(function* () {
    yield* Effect.forkScoped(recoverStaleLeases(input.attempts).pipe(Effect.ignore))
    yield* Effect.forkScoped(
      wakeAbandonedInput({ db: input.db, store: input.store, wake: input.execution.wake }).pipe(Effect.ignore),
    )
  })
