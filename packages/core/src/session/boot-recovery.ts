export * as SessionBootRecovery from "./boot-recovery"

import { and, eq, isNotNull } from "drizzle-orm"
import { Clock, Duration, Effect, Schedule, Semaphore } from "effect"
import { Log } from "@novaclaw/schema/log"
import type { Database } from "../database/database"
import { EFFECTIVE_CONFIG_DEFAULTS, resolveSessionConfig } from "./config-resolve"
import type { SessionExecution } from "./execution"
import type { SessionExecutionAttempt } from "./execution-attempt"
import { SessionInput } from "./input"
import type { SessionSchema } from "./schema"
import { SessionExecutionTable } from "./sql"
import type { SessionStore } from "./store"

/**
 * **What a dead host leaves behind, and who re-drives it.**
 *
 * Two kinds of session work are DURABLE while the thing that would run them is IN-MEMORY, so a
 * process restart — a crash, a binary replacement, an ordinary quit — strands both:
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

/** A replacement host can start before the dead one's last heartbeat is old enough to classify. */
const RESWEEP_INTERVAL = Duration.seconds(10)

/**
 * How many re-sweeps follow the boot sweep. Seven at ten seconds is a 70 s window, which covers
 * `STALE_AFTER_MS` **twice over** — a lease whose heartbeat stopped the instant before this instance
 * booted becomes classifiable 30 s in, and the window carries a full second pass after that.
 *
 * ⚠️ **BOUNDED, and the bound is the whole point.** `SessionExecutionLocal` ran this as
 * `Effect.repeat(Schedule.spaced(10s))` — forever, in the layer's scope — which was survivable only
 * because that layer has no production caller. Lifting it to `SessionV2` (where it belongs, since
 * production binds a different executor) put an **unbounded background timer into every graph that
 * builds a session service**, including every test that does. That is the runaway-under-TestClock
 * shape AGENTS.md pitfall #-1 and the win32 `session-runner` skip both describe, and it wedged the
 * whole `core` unit for ten minutes at 4 s of CPU when it was first landed.
 *
 * The justification for repeating at all was always a BOOT-WINDOW argument ("a replacement may start
 * before the dead host's last heartbeat is old enough"), so a boot-shaped window is the honest
 * schedule. A peer that dies later is a P2P concern no per-instance timer answers anyway: its own
 * replacement sweeps on ITS boot.
 */
const RESWEEP_PASSES = 7

/**
 * Reclassify leases whose owner stopped heartbeating. Sweeps once, then re-sweeps across the boot
 * window and STOPS — see {@link RESWEEP_PASSES}, which is a correctness bound, not a tidy-up.
 *
 * `recoverStale` is itself transactional and fenced on `(session_id, attempt_id, generation)`, so a
 * second host sweeping the same rows cannot double-count a failure.
 */
/**
 * ONE sweep, reading the clock when it RUNS.
 *
 * ⚠️ Exported so the advance can be asserted. `recoverStaleLeases` wraps this in a 70-second
 * schedule, so a test of the whole thing would have to wait out the window to see a second cutoff —
 * and the bug was invisible precisely because nobody did.
 */
export const sweepStaleOnce = (attempts: SessionExecutionAttempt.Interface) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* attempts.recoverStale(now - STALE_AFTER_MS)
  })

/**
 * 🔴 **THE VERDICT WAS COMPUTED AND THROWN AWAY.**
 *
 * `recoverStale` classifies every abandoned execution through `SessionRecoveryDecision.decide` and
 * stores the answer as `interrupted` (safe to resume) or `paused` (a human must look). It returns
 * that decision to its caller. **Nothing ever acted on it** — the sweep logged a count and stopped,
 * so a run interrupted mid-turn sat `interrupted` forever.
 *
 * ⚠️ `wakeAbandonedInput` below does NOT cover this. It wakes sessions holding UN-PROMOTED queued
 * input — a prompt typed while the agent was busy. A session interrupted mid-drain has already had
 * its input promoted, so it has no pending queue and that sweep skips it entirely. The two are
 * complementary and neither subsumes the other: one repairs *input nobody promoted*, this one
 * repairs *work nobody resumed*.
 *
 * Measured 2026-08-29: a serve hung under three sessions, the supervisor restarted it in a second,
 * `session.recovered: 3` was logged — and the device went idle. Three runs lost, silently.
 *
 * ⭐ **This adds no policy.** Every safety question was already answered by `decide`: a session past
 * `FAILURE_LIMIT` is `paused` (the circuit breaker against a run that keeps killing the instance),
 * while one whose tool was dispatched with an unknown outcome is resumed through an inspection
 * steer instead of replaying the tool. Only `automatic` decisions are woken here.
 */
export const resumeInterrupted = (input: {
  readonly recovered: readonly SessionExecutionAttempt.Recovered[]
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
  /** Disposable worker chats stay interrupted; their officer creates a fresh worker if needed. */
  readonly shouldResume?: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, unknown>
}) =>
  Effect.gen(function* () {
    // ⚠️ The filter is the whole safety argument, so it reads off `decision.automatic` rather than
    // re-deriving anything. A second opinion here would be a second policy, and the one that exists
    // is the one the durable state was written from.
    const policySafe = input.recovered.filter((entry) => entry.decision.automatic)
    const resumable: SessionExecutionAttempt.Recovered[] = []
    for (const entry of policySafe) {
      const shouldResume = input.shouldResume
        ? yield* input.shouldResume(entry.sessionID).pipe(Effect.catchCause(() => Effect.succeed(true)))
        : true
      if (shouldResume) resumable.push(entry)
    }
    if (resumable.length === 0) return 0
    yield* Log.event("session.interrupted.resumed", {
      "session.resumed": resumable.length,
      "session.paused": input.recovered.length - resumable.length,
    })
    // A restart can recover many root chats at once. `wake` only starts an in-memory coordinator and
    // returns, so looping over it fan-outs every recovered chat before the device scheduler sees a
    // single provider request. Three large recovered prompts plus one fresh Xenia prompt saturated
    // the Spark in the measured 0.1.72 regression: her 391-token request spent 57.5 s in provider
    // prefill and decoded at 0.24 t/s; the next uncontended turn reached first output in 0.99 s.
    // Recovery is background adoption, not three people asking at once. Join each drain before
    // adopting the next so startup cannot manufacture unbounded interactive concurrency.
    for (const entry of resumable) yield* input.resume(entry.sessionID).pipe(Effect.catchCause(() => Effect.void))
    return resumable.length
  })

export const recoverStaleLeases = (
  attempts: SessionExecutionAttempt.Interface,
  onRecovered?: (recovered: readonly SessionExecutionAttempt.Recovered[]) => Effect.Effect<unknown>,
) =>
  /**
   * 🔴 **NC-REL-010 — the cutoff has to MOVE, and it did not.** This read
   * `attempts.recoverStale(Date.now() - STALE_AFTER_MS)`, which evaluates `Date.now()` once, while
   * the Effect VALUE is being built. `Effect.repeat` below then re-ran that same value — and
   * therefore the same frozen number — through all seven passes.
   *
   * So the re-sweeps could only ever find what the FIRST sweep already could. An execution abandoned
   * five seconds into the boot window keeps a heartbeat newer than a cutoff that never advances, and
   * is never recovered — which is the exact case `RESWEEP_PASSES` exists for. The bound is described
   * in its own comment as "a correctness bound, not a tidy-up", and it was buying nothing.
   *
   * ⚠️ `Clock.currentTimeMillis` rather than `Date.now()` inside a `suspend`: it is re-read per pass
   * either way, but the Clock is what makes the advance assertable under `TestClock` instead of
   * needing seventy seconds of real time to observe.
   */
  sweepStaleOnce(attempts).pipe(
    // Only a sweep that FOUND something is worth a line: an unconditional record would be one line
    // per interval for the whole window, saying nothing.
    Effect.flatMap((recovered) =>
      recovered.length === 0
        ? Effect.void
        : Log.event("session.lease.stale.recovered", { "session.recovered": recovered.length }).pipe(
            // 🔴 The sweep used to END here, which is the whole defect: it reclassified the rows and
            // dropped the verdict it had just computed. `onRecovered` is where the verdict becomes an
            // action; it is optional so the sweep keeps working for a caller that only wants the
            // reclassification (and so every existing test of this function is unchanged).
            Effect.andThen(onRecovered ? onRecovered(recovered) : Effect.void),
          ),
    ),
    Effect.repeat(Schedule.spaced(RESWEEP_INTERVAL).pipe(Schedule.take(RESWEEP_PASSES))),
  )

/**
 * Hand every session holding durable work back to the executor, exactly as the admission or recovery
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
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
}) {
  const pending = yield* SessionInput.sessionsWithPendingQueue(input.db)
  // A replacement drain used to read the provider-recovery latch only AFTER its first empty-queue
  // return. It therefore settled successfully without consuming the latch. That state is durable and
  // otherwise has no future wake source, so upgrades must adopt it just like an abandoned prompt.
  const strandedRecovery = yield* input.db
    .select({ sessionID: SessionExecutionTable.session_id })
    .from(SessionExecutionTable)
    .where(and(eq(SessionExecutionTable.state, "settled"), isNotNull(SessionExecutionTable.provider_recovery)))
    .all()
    .pipe(Effect.orDie)
  const sessions = [...new Set([...pending, ...strandedRecovery.map((row) => row.sessionID)])]
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
    // This is the sibling boot-time fan-out source. Pending prompts are durable, so joining each
    // drain bounds adoption without losing work.
    yield* input.resume(sessionID).pipe(Effect.catchCause(() => Effect.void))
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
 * exactly where the self-healing law is void, so a recovery that cannot run must
 * degrade rather than take the instance down with it.
 */
export const start = (input: {
  readonly db: Database.Interface["db"]
  readonly store: SessionStore.Interface
  readonly attempts: SessionExecutionAttempt.Interface
  readonly execution: SessionExecution.Interface
  /**
   * Whether a run interrupted mid-turn is resumed — `harness_drives.resumeInterrupted`, default ON.
   *
   * ⚠️ Read as a THUNK, not a boolean, so the switch is consulted when a sweep actually recovers
   * something rather than once at layer construction. Ruling 3: *a settings change is not a reboot*,
   * and the re-sweeps run across a 70-second boot window during which an operator may well be
   * turning this off precisely because a run is misbehaving.
   */
  readonly resumeInterrupted?: () => Effect.Effect<boolean>
}) =>
  Effect.gen(function* () {
    // Both durable-work scans share one lane. Two separately serial loops would still run one
    // recovered chat from each arm at the same time.
    const recoveryLane = yield* Semaphore.make(1)
    yield* Effect.forkScoped(
      recoverStaleLeases(input.attempts, (recovered) =>
        Effect.gen(function* () {
          const enabled = input.resumeInterrupted === undefined ? true : yield* input.resumeInterrupted()
          if (!enabled) return
          yield* recoveryLane.withPermits(1)(
            resumeInterrupted({
              recovered,
              resume: input.execution.resume,
              // Spawned workers are disposable attempts owned by their superior. Resurrecting
              // their old contexts duplicates uncertain work and, in the measured restart, sent
              // two 80k prompts beside Geryon. Leave them interrupted; the freshly recovered
              // officer sees that result and may spawn a new worker from current filesystem state.
              shouldResume: (sessionID) =>
                input.store.get(sessionID).pipe(
                  Effect.map(
                    (session) =>
                      session === undefined || (session.parentID === undefined && session.type !== "sub-agent"),
                  ),
                  Effect.catchCause(() => Effect.succeed(true)),
                ),
            }),
          )
        }),
      ).pipe(Effect.ignore),
    )
    yield* Effect.forkScoped(
      recoveryLane
        .withPermits(1)(wakeAbandonedInput({ db: input.db, store: input.store, resume: input.execution.resume }))
        .pipe(Effect.ignore),
    )
  })
