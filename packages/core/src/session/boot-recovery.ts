export * as SessionBootRecovery from "./boot-recovery"

import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm"
import { Clock, Duration, Effect, Schedule, Semaphore } from "effect"
import { Log } from "@novaclaw/schema/log"
import type { Database } from "../database/database"
import { EFFECTIVE_CONFIG_DEFAULTS, resolveSessionConfig } from "./config-resolve"
import type { SessionExecution } from "./execution"
import type { SessionExecutionAttempt } from "./execution-attempt"
import { SessionInput } from "./input"
import { SessionSchema } from "./schema"
import { SessionExecutionTable } from "./sql"
import type { SessionStore } from "./store"

/**
 * **What a dead host leaves behind, and who re-drives it.**
 *
 * Two kinds of session work are DURABLE while the thing that would run them is IN-MEMORY, so a
 * process restart — a crash, a binary replacement, an ordinary quit — strands both:
 *
 *   1. **A lease left mid-flight.** `session_execution` rows sit in `starting`/`busy`/`recovering`
 *      with a heartbeat that stopped. Only `recoverStale` reclassifies them for automatic recovery,
 *      and until it runs the session reports *busy* forever
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
 * stores it as `recovering` for automatic recovery. It returns
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
 * A process loss has no authority to stop a user's work. An uncertain tool outcome is resumed
 * through an inspection steer instead of replaying the tool, and repeated failures are paced by the
 * worker executor rather than converted into a terminal session state.
 */
const descendantsFirst = Effect.fn("SessionBootRecovery.descendantsFirst")(function* (input: {
  readonly sessionIDs: readonly SessionSchema.ID[]
  readonly parentOf?: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.ID | undefined, unknown>
}) {
  const ordered = [...input.sessionIDs]
  if (!input.parentOf) return ordered

  const parents = new Map<SessionSchema.ID, SessionSchema.ID | undefined>()
  for (const sessionID of ordered)
    parents.set(sessionID, yield* input.parentOf(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined))))
  const recoveredIDs = new Set(ordered)
  const depth = (id: SessionSchema.ID, visiting = new Set<SessionSchema.ID>()): number => {
    if (visiting.has(id)) return 0
    const parent = parents.get(id)
    if (parent === undefined || !recoveredIDs.has(parent)) return 0
    return 1 + depth(parent, new Set([...visiting, id]))
  }
  // Preserve dependency order at admission too: descendants should be visible to the scheduler
  // before an officer that may immediately resume a durable wait(child).
  return ordered.sort((a, b) => depth(b) - depth(a))
})

/**
 * 🔴 **THE QUESTION EVERY BOOT ARM MUST ASK, AND THAT NONE OF THEM ASKED.**
 *
 * Each arm below enumerates leftover WORK — an un-promoted `session_input` row, a stranded provider
 * latch, a state that stopped mid-flight. None of those tables has any notion of a STOP. A queue row
 * records that a prompt was ACCEPTED; it does not record that anyone still wants it run. So the arms
 * honoured `invariants.md` ("User to just stop the agent" is one of the four legal stops, "everything
 * else leads to guaranteed recovery") exactly as far as each one happened to read
 * `session_execution` — which is to say one of the three did, and the pending-queue arm, the busiest
 * one, did not read it at all.
 *
 * Measured in production on `ses_geryon`: the user stopped it and the stop was recorded CORRECTLY
 * (`state='interrupted', failure_class='interrupt'`), and it was still adopted on every restart —
 * because a stall nudge had left one unpromoted `queue` row behind, and that arm's query is
 * `promoted_seq IS NULL AND delivery='queue'` with no join to anything that could object.
 *
 * `failure_class='interrupt'` is the mark `requestInterrupt` writes, and the first new attempt nulls
 * it (`execution-attempt.ts`), so a row still carrying it means: someone stopped this session and
 * NOTHING has run since. That is the whole question, asked once at the single door where boot turns
 * leftover work into a running session — which is why it lives on the adopt function rather than in
 * any one arm, and why it re-reads the row per session instead of snapshotting: a snapshot taken
 * before the sweeps run is stale in exactly the direction that matters, and the read is a primary-key
 * lookup on a table with one row per session.
 *
 * ⚠️ This gates BOOT adoption only, and deliberately so. A session the user re-prompts still carries
 * the mark at admission time — the attempt that clears it opens later, inside the drain — so putting
 * the same check inside `execution.adopt` would refuse a legitimate resume. Runtime admissions are
 * not this door.
 */
export const holdStopped = (input: {
  readonly db: Database.Interface["db"]
  readonly adopt: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
}) =>
  Effect.fn("SessionBootRecovery.holdStopped")(function* (sessionID: SessionSchema.ID) {
    const stopped = yield* input.db
      .select({ sessionID: SessionExecutionTable.session_id })
      .from(SessionExecutionTable)
      .where(
        and(
          eq(SessionExecutionTable.session_id, sessionID),
          eq(SessionExecutionTable.failure_class, "interrupt"),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    if (stopped.length === 0) return yield* input.adopt(sessionID)
    // Silent recovery is the defect this function exists to end; silent refusal must at least be
    // readable in the log, or a session that stays stopped looks identical to one that is stuck.
    yield* Log.event("session.boot.recovery.held", {
      "session.id": sessionID,
      "session.reason": "stopped",
    })
  })

export const adoptRecovered = (input: {
  readonly recovered: readonly SessionExecutionAttempt.Recovered[]
  readonly adopt: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
  readonly parentOf?: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.ID | undefined, unknown>
}) =>
  Effect.gen(function* () {
    // Spawned workers are included: leaving one interrupted strands its parent's durable wait and
    // loses delegated work. Recovery reconstructs the worker from persisted state instead.
    const resumable = yield* descendantsFirst({
      sessionIDs: input.recovered.map((entry) => entry.sessionID),
      parentOf: input.parentOf,
    })
    if (resumable.length === 0) return 0
    yield* Log.event("session.interrupted.resumed", {
      "session.resumed": resumable.length,
      "session.paused": input.recovered.length - resumable.length,
    })
    // Adoption is detached but forced: every durable turn reaches the device scheduler immediately,
    // where configured device concurrency and EEVDF fairness own pacing. Joining here made one
    // long-running child a global boot lock: its parent and every unrelated recovered officer could
    // remain visibly idle for hours despite durable unfinished work.
    for (const sessionID of resumable) yield* input.adopt(sessionID).pipe(Effect.catchCause(() => Effect.void))
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
  readonly adopt: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
  /** A boot-time snapshot. Omit only for an explicit, immediate recovery sweep. */
  readonly sessionIDs?: readonly SessionSchema.ID[]
}) {
  const candidates =
    input.sessionIDs ??
    (yield* abandonedSessionIDs({
      db: input.db,
    }))
  const sessions = yield* descendantsFirst({
    sessionIDs: candidates,
    parentOf: (sessionID) =>
      input.store.get(sessionID).pipe(Effect.map((session) => session?.parentID as SessionSchema.ID | undefined)),
  })
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
    yield* input.adopt(sessionID).pipe(Effect.catchCause(() => Effect.void))
    woken++
  }
  yield* Log.event("session.input.abandoned.resumed", {
    "session.resumed": woken,
    "session.handedOff": handedOff,
  })
  return woken
})

/**
 * Snapshot the durable work a process restart could have abandoned.
 *
 * This read must finish before `start` forks its adoption fiber. If the query itself lived inside
 * that detached fiber, a prompt admitted after service construction could enter the result and be
 * misclassified as crash residue — violating `prompt({ resume: false })` and racing an explicit
 * runner with a second drain.
 */
export const abandonedSessionIDs = Effect.fn("SessionBootRecovery.abandonedSessionIDs")(function* (input: {
  readonly db: Database.Interface["db"]
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
  // Builds before perpetual recovery classified process loss as `interrupted` and then abandoned
  // the row. Adopt those durable turns too. `interrupt` is the authority-bearing state written by
  // an explicit user/Nova stop, and must remain stopped. Include NULL for older rows.
  const strandedInterrupted = yield* input.db
    .select({ sessionID: SessionExecutionTable.session_id })
    .from(SessionExecutionTable)
    .where(
      and(
        inArray(SessionExecutionTable.state, ["paused", "failed", "interrupted", "recovering"]),
        or(isNull(SessionExecutionTable.failure_class), ne(SessionExecutionTable.failure_class, "interrupt")),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  return [
    ...new Set([
      ...pending,
      ...strandedRecovery.map((row) => SessionSchema.ID.make(row.sessionID)),
      ...strandedInterrupted.map((row) => SessionSchema.ID.make(row.sessionID)),
    ]),
  ]
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
}) =>
  Effect.gen(function* () {
    // Both durable-work scans share one short adoption lane so the same session cannot be claimed
    // twice. Adoption itself never joins a drain; device scheduling owns concurrency afterwards.
    const recoveryLane = yield* Semaphore.make(1)
    // ONE gate for both arms: whatever a sweep found, a session someone stopped stays stopped. See
    // `holdStopped` — the arms enumerate work, and work is not consent.
    const adopt = holdStopped({ db: input.db, adopt: input.execution.adopt })
    // Snapshot before either detached arm can yield. A delayed query would see prompts admitted
    // after boot and steal `resume: false` work as though the previous process had abandoned it.
    const abandoned = yield* abandonedSessionIDs({ db: input.db }).pipe(
      // Both recovery arms are independently non-fatal. Moving the read out of the fork must not
      // turn an unavailable recovery table into an instance boot failure.
      Effect.catchCause(() => Effect.succeed([] as readonly SessionSchema.ID[])),
    )
    yield* Effect.forkScoped(
      recoverStaleLeases(input.attempts, (recovered) =>
        Effect.gen(function* () {
          yield* recoveryLane.withPermits(1)(
            adoptRecovered({
              recovered,
              adopt,
              parentOf: (sessionID) =>
                input.store
                  .get(sessionID)
                  .pipe(Effect.map((session) => session?.parentID as SessionSchema.ID | undefined)),
            }),
          )
        }),
      ).pipe(Effect.ignore),
    )
    yield* Effect.forkScoped(
      recoveryLane
        .withPermits(1)(wakeAbandonedInput({ db: input.db, store: input.store, adopt, sessionIDs: abandoned }))
        .pipe(Effect.ignore),
    )
  })
