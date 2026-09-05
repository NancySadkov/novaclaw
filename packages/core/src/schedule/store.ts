export * as CalendarStore from "./store"

// Calendar / cron-session creator (P1). Pure DB functions over the schedule + fire tables (the JhStore
// pattern: take `db`, no service), so the ticker (P2) calls them from its fiber and tests exercise them on
// an in-memory DB. `now` is passed in (never Date.now()) so next-fire computation is deterministic; the
// caller supplies `yield* Clock.currentTimeMillis`. next_fire_at is computed via schedule/recurrence.ts on
// create and advance, and on an update only when that update changes WHEN the schedule fires; it is null
// while a schedule is disabled.

import { and, asc, desc, eq, inArray, isNotNull, lte, lt } from "drizzle-orm"
import { Effect } from "effect"
import { ascending } from "@novaclaw/schema/identifier"
import { PermissionMode } from "@novaclaw/schema/session-message"
import type { Database } from "../database/database"
import { nextFire, sameRecurrence, type EpochMillis, type Recurrence } from "./recurrence"
import { CalendarFireTable, CalendarScheduleTable } from "./calendar.sql"
import type { FireOutcome } from "./calendar.sql"
import { LogSettings } from "../observability/log-settings"
import { SessionExecutionTable, SessionTable } from "../session/sql"

type Db = Database.Interface["db"]

export type FireStatus = "spawned" | "skipped" | "error"

/** Keep one scheduler pass bounded even when an old instance has a large backlog. */
export const FIRE_PRUNE_BATCH = 500

/**
 * 🔴 THE LEDGER MAY NEVER CLAIM MORE THAN HAPPENED.
 *
 * An occurrence has to be claimed BEFORE the work, or two tickers run it twice; so the claim row exists
 * while the run has not happened yet, and a process that dies in that window leaves the row behind. What
 * the row says at that moment is therefore what a crash makes PERMANENT, and it must be the weakest true
 * statement available — never the outcome we are hoping for.
 *
 * `skipped` is that statement: "this occurrence produced no session". True the instant it is written,
 * still true forever if this process never returns, and promoted to `spawned`/`error` by
 * `setFireOutcome` once the launch has actually resolved. Nothing else in the tree writes it (swept:
 * zero other writers), so no existing meaning is overloaded, and status is only ever promoted — a row
 * read as `skipped` never ran.
 *
 * ⚠️ Claiming as `spawned` is the mistake this replaces: it recorded a session that did not exist and
 * made the occurrence indistinguishable from one that genuinely ran, so nothing could ever retry it.
 */
const CLAIM_STATUS: FireStatus = "skipped"

/**
 * How long a claim may sit unresolved before another cycle may take it over. A claim is resolved
 * within one launch, so anything left this long belongs to a process that is gone.
 *
 * Human units on purpose (AGENTS.md principle 12(c)): five MINUTES, not a millisecond literal. It is
 * also the cost of the failure — a run interrupted by a crash restarts at most five minutes late — and
 * it is deliberately many times a tick, because re-running an unattended task twice is worse than
 * running it late.
 */
export const RECLAIM_ABANDONED_AFTER_MINUTES = 5

/**
 * How long an abandoned claim stays worth recovering. Past it the occurrence is left as it stands — a
 * ledger row that honestly says no session came of it — and the schedule rolls on.
 *
 * ⚠️ This bound is the whole reason recovery cannot become a crash loop. A task that KILLS the process
 * abandons its claim every time, so an unbounded retry would relaunch the killer every few minutes
 * forever. One hour buys back a run interrupted by a reboot and stops there.
 */
export const RECOVERABLE_FOR_MINUTES = 60

/**
 * What a tick learned when it asked for an occurrence. Deliberately four cases rather than a boolean:
 * "somebody else has it" and "it already ran" used to collapse into the same `false`, and rolling the
 * schedule forward on that answer is exactly how a crashed run was lost.
 */
export type OccurrenceClaim =
  /** Ours, freshly recorded. Run it. */
  | { readonly kind: "claimed" }
  /** Ours, taken over from a process that died mid-run. Run it. */
  | { readonly kind: "reclaimed"; readonly abandonedAt: number }
  /** Somebody else is running it right now. Do NOT run it, and do NOT roll the schedule past it. */
  | { readonly kind: "in-flight"; readonly since: number }
  /** It already resolved. Do not run it; the schedule may roll forward. */
  | { readonly kind: "settled"; readonly status: FireStatus }

export interface Schedule {
  readonly id: string
  readonly title: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin: number
  readonly prompt: string
  readonly agent: string | null
  readonly model: string | null
  readonly location: string | null
  readonly permissionMode: PermissionMode | null
  readonly enabled: boolean
  readonly nextFireAt: number | null
  readonly lastFiredAt: number | null
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface CreateInput {
  readonly title?: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin?: number
  readonly prompt: string
  readonly agent?: string | null
  readonly model?: string | null
  readonly location?: string | null
  readonly permissionMode?: PermissionMode | null
  readonly enabled?: boolean
}

export interface UpdateInput {
  readonly title?: string
  readonly recurrence?: Recurrence
  readonly tzOffsetMin?: number
  readonly prompt?: string
  readonly agent?: string | null
  readonly model?: string | null
  readonly location?: string | null
  readonly permissionMode?: PermissionMode | null
  readonly enabled?: boolean
}

export interface FireInput {
  readonly scheduleId: string
  readonly occurrenceMillis: number
  readonly firedAt: number
  readonly sessionId?: string | null
  readonly status: FireStatus
}

/**
 * ⚠️ TOTAL on purpose. `permission_mode` is a `text` column that predates the contract narrowing the
 * field, so a legacy row can hold a mode the runner does not implement. Reading it back as an
 * arbitrary string is what put a bare `string` on the wire; turning it into a 500 on
 * `GET /api/calendar/schedule` would be worse. Unrecognised degrades to "inherit the default".
 */
const isPermissionMode = (value: string | null): value is PermissionMode =>
  value !== null && (PermissionMode.literals as readonly string[]).includes(value)

const toSchedule = (row: typeof CalendarScheduleTable.$inferSelect): Schedule => ({
  id: row.id,
  title: row.title,
  recurrence: JSON.parse(row.recurrence_json) as Recurrence,
  tzOffsetMin: row.tz_offset_min,
  prompt: row.prompt,
  agent: row.agent,
  model: row.model,
  location: row.location_json,
  permissionMode: isPermissionMode(row.permission_mode) ? row.permission_mode : null,
  enabled: row.enabled,
  nextFireAt: row.next_fire_at,
  lastFiredAt: row.last_fired_at,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

/** next_fire_at for a schedule: the next fire strictly after `now`, or null while disabled. */
const computeNext = (recurrence: Recurrence, enabled: boolean, tzOffsetMin: number, now: EpochMillis) =>
  enabled ? nextFire(recurrence, now, tzOffsetMin) : null

export const get = (db: Db, id: string): Effect.Effect<Schedule | undefined> =>
  db
    .select()
    .from(CalendarScheduleTable)
    .where(eq(CalendarScheduleTable.id, id))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => (row ? toSchedule(row) : undefined)),
    )

export const list = (db: Db): Effect.Effect<Schedule[]> =>
  db
    .select()
    .from(CalendarScheduleTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toSchedule)),
    )

export const create = (db: Db, input: CreateInput, now: EpochMillis): Effect.Effect<Schedule> =>
  Effect.gen(function* () {
    const id = "cal_" + ascending()
    const tz = input.tzOffsetMin ?? 0
    const enabled = input.enabled ?? true
    yield* db
      .insert(CalendarScheduleTable)
      .values({
        id,
        title: input.title ?? "",
        recurrence_json: JSON.stringify(input.recurrence),
        tz_offset_min: tz,
        prompt: input.prompt,
        agent: input.agent ?? null,
        model: input.model ?? null,
        location_json: input.location ?? null,
        permission_mode: input.permissionMode ?? null,
        enabled,
        next_fire_at: computeNext(input.recurrence, enabled, tz, now),
        last_fired_at: null,
      })
      .run()
      .pipe(Effect.orDie)
    // Just inserted — the row exists.
    return (yield* get(db, id))!
  })

/**
 * Patch a schedule.
 *
 * 🔴 next_fire_at is recomputed only when the patch actually CHANGES when it fires. Recomputing it
 * unconditionally silently drops an occurrence that is already due but has not been ticked yet: the
 * next fire is always computed strictly after `now`, so renaming a 06:00 task at 06:00:10 moved it to
 * tomorrow and that morning's run simply never happened.
 *
 * ⚠️ The test is the VALUE, not whether the field appears in the patch. The editor round-trips the whole
 * form on save, so a rename arrives carrying an identical `recurrence` and `tzOffsetMin`; a
 * presence-based test would call that a reschedule and lose the occurrence exactly as before.
 */
export const update = (db: Db, id: string, patch: UpdateInput, now: EpochMillis): Effect.Effect<Schedule | undefined> =>
  Effect.gen(function* () {
    const existing = yield* get(db, id)
    if (existing === undefined) return undefined
    const recurrence = patch.recurrence ?? existing.recurrence
    const tz = patch.tzOffsetMin ?? existing.tzOffsetMin
    const enabled = patch.enabled ?? existing.enabled
    // Pausing stands a schedule down deliberately, so resuming picks up from `now` rather than
    // resurrecting whatever came due while it was off — that is what the pause was for. Every other
    // patch leaves the stored instant exactly as it was, still due if it was already due.
    const timingChanged =
      !sameRecurrence(recurrence, existing.recurrence) || tz !== existing.tzOffsetMin || enabled !== existing.enabled
    const nextFireAt = timingChanged ? computeNext(recurrence, enabled, tz, now) : existing.nextFireAt
    yield* db
      .update(CalendarScheduleTable)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.recurrence !== undefined ? { recurrence_json: JSON.stringify(patch.recurrence) } : {}),
        tz_offset_min: tz,
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.agent !== undefined ? { agent: patch.agent } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.location !== undefined ? { location_json: patch.location } : {}),
        ...(patch.permissionMode !== undefined ? { permission_mode: patch.permissionMode } : {}),
        enabled,
        next_fire_at: nextFireAt,
      })
      .where(eq(CalendarScheduleTable.id, id))
      .run()
      .pipe(Effect.orDie)
    return yield* get(db, id)
  })

export const remove = (db: Db, id: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Keep the explicit delete in the store boundary as well as the database cascade: this path remains
    // correct for a database opened before the relationship migration, and is safe on fresh databases.
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.delete(CalendarFireTable).where(eq(CalendarFireTable.schedule_id, id)).run().pipe(Effect.orDie)
        yield* tx.delete(CalendarScheduleTable).where(eq(CalendarScheduleTable.id, id)).run().pipe(Effect.orDie)
      }),
    ).pipe(Effect.orDie)
  })

/** Enabled schedules whose next fire is now due (next_fire_at != null is implied by the `<=` filter). */
export const due = (db: Db, now: EpochMillis): Effect.Effect<Schedule[]> =>
  db
    .select()
    .from(CalendarScheduleTable)
    .where(and(eq(CalendarScheduleTable.enabled, true), lte(CalendarScheduleTable.next_fire_at, now)))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toSchedule)),
    )

/**
 * Record that an occurrence fired, with its outcome already known. Returns false (no-op) when this exact
 * occurrence was already recorded. The unique index on (schedule_id, occurrence_millis) is the hard
 * backstop; onConflictDoNothing covers the check→insert race.
 *
 * ⚠️ NOT the ticker's path — it claims through `claimOccurrence`, which owns the claim status. This
 * remains for a caller that has an outcome in hand and nothing to claim.
 */
export const recordFire = (db: Db, input: FireInput): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const existing = yield* db
      .select()
      .from(CalendarFireTable)
      .where(
        and(
          eq(CalendarFireTable.schedule_id, input.scheduleId),
          eq(CalendarFireTable.occurrence_millis, input.occurrenceMillis),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (existing !== undefined && existing !== null) return false
    yield* db
      .insert(CalendarFireTable)
      .values({
        id: "fire_" + ascending(),
        schedule_id: input.scheduleId,
        occurrence_millis: input.occurrenceMillis,
        fired_at: input.firedAt,
        session_id: input.sessionId ?? null,
        status: input.status,
        outcome: input.status === "error" ? "failed" : "pending",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return true
  })

const fireRow = (db: Db, scheduleId: string, occurrenceMillis: number) =>
  db
    .select()
    .from(CalendarFireTable)
    .where(
      and(eq(CalendarFireTable.schedule_id, scheduleId), eq(CalendarFireTable.occurrence_millis, occurrenceMillis)),
    )
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row ?? undefined),
    )

/**
 * Take this occurrence, or say who has it. The ONLY way the ticker enters the fire ledger — the claim's
 * status is not the caller's to choose, so a claim can no longer be written as an outcome.
 *
 * A claim left unresolved for `RECLAIM_ABANDONED_AFTER_MINUTES` belonged to a process that is gone, and
 * is taken over rather than mistaken for a completed run. The take-over is a guarded UPDATE and the
 * winner is confirmed by reading the lease back, so two instances on one database cannot both take it.
 */
export const claimOccurrence = (
  db: Db,
  input: { readonly scheduleId: string; readonly occurrenceMillis: number; readonly now: EpochMillis },
): Effect.Effect<OccurrenceClaim> =>
  Effect.gen(function* () {
    const existing = yield* fireRow(db, input.scheduleId, input.occurrenceMillis)
    if (existing === undefined) {
      yield* db
        .insert(CalendarFireTable)
        .values({
          id: "fire_" + ascending(),
          schedule_id: input.scheduleId,
          occurrence_millis: input.occurrenceMillis,
          fired_at: input.now,
          session_id: null,
          status: CLAIM_STATUS,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      // onConflictDoNothing swallows the check->insert race; the row decides who actually holds it.
      const held = yield* fireRow(db, input.scheduleId, input.occurrenceMillis)
      if (held === undefined || held.fired_at !== input.now || held.status !== CLAIM_STATUS)
        return { kind: "in-flight", since: held?.fired_at ?? input.now }
      return { kind: "claimed" }
    }
    if (existing.status !== CLAIM_STATUS) return { kind: "settled", status: existing.status }

    const abandonedBefore = input.now - RECLAIM_ABANDONED_AFTER_MINUTES * 60_000
    if (existing.fired_at > abandonedBefore) return { kind: "in-flight", since: existing.fired_at }
    // Too old to be worth resurrecting: the row already says no session came of it, so let the schedule
    // move on rather than relaunching a run whose window has passed.
    if (existing.fired_at < input.now - RECOVERABLE_FOR_MINUTES * 60_000)
      return { kind: "settled", status: existing.status }
    yield* db
      .update(CalendarFireTable)
      .set({ fired_at: input.now })
      .where(
        and(
          eq(CalendarFireTable.schedule_id, input.scheduleId),
          eq(CalendarFireTable.occurrence_millis, input.occurrenceMillis),
          eq(CalendarFireTable.status, CLAIM_STATUS),
          lte(CalendarFireTable.fired_at, abandonedBefore),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    const taken = yield* fireRow(db, input.scheduleId, input.occurrenceMillis)
    if (taken === undefined || taken.fired_at !== input.now)
      return { kind: "in-flight", since: taken?.fired_at ?? input.now }
    return { kind: "reclaimed", abandonedAt: existing.fired_at }
  })

/**
 * Stamp a fire row's session/status once the launch has resolved — the promotion out of the claim.
 *
 * Guarded on the row still being a claim: a process that comes back from the dead after its occurrence
 * was reclaimed and re-run must not overwrite the newer outcome with its own stale one.
 */
export const setFireOutcome = (
  db: Db,
  input: {
    readonly scheduleId: string
    readonly occurrenceMillis: number
    readonly sessionId?: string | null
    readonly status: FireStatus
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* db
      .update(CalendarFireTable)
      .set({
        session_id: input.sessionId ?? null,
        status: input.status,
        outcome: input.status === "error" ? "failed" : "pending",
      })
      .where(
        and(
          eq(CalendarFireTable.schedule_id, input.scheduleId),
          eq(CalendarFireTable.occurrence_millis, input.occurrenceMillis),
          eq(CalendarFireTable.status, CLAIM_STATUS),
        ),
      )
      .run()
      .pipe(Effect.orDie)
  })

/**
 * Project the terminal state of scheduled sessions into the fire ledger.
 *
 * `calendar_fire.status = spawned` only means that durable session admission succeeded. The
 * session execution row is the authoritative lifecycle for what happened after that point; copying
 * its terminal state here makes Calendar history answerable without joining live session tables at
 * read time. The `outcome = pending` predicate is the fence: a later manual prompt cannot rewrite a
 * scheduled occurrence that has already been accounted for.
 */
export const reconcileFireOutcomes = (db: Db): Effect.Effect<number> =>
  Effect.gen(function* () {
    const pending = yield* db
      .select({
        id: CalendarFireTable.id,
        sessionResult: SessionTable.result,
        executionState: SessionExecutionTable.state,
      })
      .from(CalendarFireTable)
      .leftJoin(SessionTable, eq(CalendarFireTable.session_id, SessionTable.id))
      .leftJoin(SessionExecutionTable, eq(CalendarFireTable.session_id, SessionExecutionTable.session_id))
      .where(and(eq(CalendarFireTable.outcome, "pending"), isNotNull(CalendarFireTable.session_id)))
      .all()
      .pipe(Effect.orDie)

    let changed = 0
    for (const row of pending) {
      const outcome: FireOutcome | undefined =
        row.sessionResult !== null && row.sessionResult !== undefined
          ? "succeeded"
          : row.executionState === "settled"
            ? "succeeded"
            : row.executionState === "failed"
              ? "failed"
              : row.executionState === "interrupted"
                ? "interrupted"
                : undefined
      if (outcome === undefined) continue
      const updated = yield* db
        .update(CalendarFireTable)
        .set({ outcome })
        .where(and(eq(CalendarFireTable.id, row.id), eq(CalendarFireTable.outcome, "pending")))
        .returning({ id: CalendarFireTable.id })
        .all()
        .pipe(Effect.orDie)
      changed += updated.length
    }
    return changed
  })

/**
 * Delete historical fire rows without touching the occurrence currently owned by a schedule.
 *
 * The `skipped` status is also the in-flight claim marker. A time-only DELETE would therefore make
 * an old-but-still-due claim look absent and could launch it a second time. The schedule's
 * `next_fire_at` is the authoritative exception: rows older than that instant are historical, while
 * the equal row is the live claim and stays until the scheduler settles or advances it. Orphan rows
 * are safe to remove because no schedule can ask the idempotency ledger about them again.
 */
export const pruneFires = (db: Db, now: EpochMillis, retentionMs = LogSettings.maxAgeMs()): Effect.Effect<number> =>
  Effect.gen(function* () {
    const cutoff = now - retentionMs
    const stale = yield* db
      .select({
        id: CalendarFireTable.id,
        scheduleId: CalendarFireTable.schedule_id,
        occurrenceMillis: CalendarFireTable.occurrence_millis,
      })
      .from(CalendarFireTable)
      .where(lt(CalendarFireTable.fired_at, cutoff))
      .orderBy(asc(CalendarFireTable.fired_at))
      .limit(FIRE_PRUNE_BATCH)
      .all()
      .pipe(Effect.orDie)
    if (stale.length === 0) return 0

    const schedules = yield* db
      .select({ id: CalendarScheduleTable.id, nextFireAt: CalendarScheduleTable.next_fire_at })
      .from(CalendarScheduleTable)
      .all()
      .pipe(Effect.orDie)
    const nextFireBySchedule = new Map(schedules.map((schedule) => [schedule.id, schedule.nextFireAt]))
    const removable = stale
      .filter((fire) => {
        const next = nextFireBySchedule.get(fire.scheduleId)
        return next === undefined || next === null || fire.occurrenceMillis < next
      })
      .map((fire) => fire.id)
    if (removable.length === 0) return 0
    yield* db.delete(CalendarFireTable).where(inArray(CalendarFireTable.id, removable)).run().pipe(Effect.orDie)
    return removable.length
  })

/** After firing, stamp last_fired_at and advance next_fire_at to the next occurrence strictly after `now`. */
export const advance = (db: Db, id: string, now: EpochMillis): Effect.Effect<Schedule | undefined> =>
  Effect.gen(function* () {
    const existing = yield* get(db, id)
    if (existing === undefined) return undefined
    yield* db
      .update(CalendarScheduleTable)
      .set({
        last_fired_at: now,
        next_fire_at: computeNext(existing.recurrence, existing.enabled, existing.tzOffsetMin, now),
      })
      .where(eq(CalendarScheduleTable.id, id))
      .run()
      .pipe(Effect.orDie)
    return yield* get(db, id)
  })

export const fires = (db: Db, scheduleId: string): Effect.Effect<Array<typeof CalendarFireTable.$inferSelect>> =>
  db.select().from(CalendarFireTable).where(eq(CalendarFireTable.schedule_id, scheduleId)).all().pipe(Effect.orDie)

export interface Fire {
  readonly id: string
  readonly scheduleId: string
  readonly occurrenceMillis: number
  readonly firedAt: number
  readonly sessionId: string | null
  readonly status: FireStatus
  readonly outcome: FireOutcome
}

const toFire = (row: typeof CalendarFireTable.$inferSelect): Fire => ({
  id: row.id,
  scheduleId: row.schedule_id,
  occurrenceMillis: row.occurrence_millis,
  firedAt: row.fired_at,
  sessionId: row.session_id,
  status: row.status,
  outcome: row.outcome,
})

/** Recent fires across all schedules, newest first — the "recent runs" history for the Calendar UI. */
export const recentFires = (db: Db, limit = 20): Effect.Effect<Fire[]> =>
  db
    .select()
    .from(CalendarFireTable)
    .orderBy(desc(CalendarFireTable.fired_at))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toFire)),
    )
