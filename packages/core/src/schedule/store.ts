export * as CalendarStore from "./store"

// Calendar / cron-session creator (P1). Pure DB functions over the schedule + fire tables (the JhStore
// pattern: take `db`, no service), so the ticker (P2) calls them from its fiber and tests exercise them on
// an in-memory DB. `now` is passed in (never Date.now()) so next-fire computation is deterministic; the
// caller supplies `yield* Clock.currentTimeMillis`. next_fire_at is recomputed via schedule/recurrence.ts
// on every create/update/advance, and set to null while a schedule is disabled.

import { and, desc, eq, lte } from "drizzle-orm"
import { Effect } from "effect"
import { ascending } from "@novaclaw/schema/identifier"
import type { Database } from "../database/database"
import { nextFire, type EpochMillis, type Recurrence } from "./recurrence"
import { CalendarFireTable, CalendarScheduleTable } from "./calendar.sql"

type Db = Database.Interface["db"]

export type FireStatus = "spawned" | "skipped" | "error"

export interface Schedule {
  readonly id: string
  readonly title: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin: number
  readonly prompt: string
  readonly agent: string | null
  readonly model: string | null
  readonly location: string | null
  readonly permissionMode: string | null
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
  readonly permissionMode?: string | null
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
  readonly permissionMode?: string | null
  readonly enabled?: boolean
}

export interface FireInput {
  readonly scheduleId: string
  readonly occurrenceMillis: number
  readonly firedAt: number
  readonly sessionId?: string | null
  readonly status: FireStatus
}

const toSchedule = (row: typeof CalendarScheduleTable.$inferSelect): Schedule => ({
  id: row.id,
  title: row.title,
  recurrence: JSON.parse(row.recurrence_json) as Recurrence,
  tzOffsetMin: row.tz_offset_min,
  prompt: row.prompt,
  agent: row.agent,
  model: row.model,
  location: row.location_json,
  permissionMode: row.permission_mode,
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

/** Patch a schedule; recomputes next_fire_at from `now` (recurrence/tz/enabled can all shift it). */
export const update = (
  db: Db,
  id: string,
  patch: UpdateInput,
  now: EpochMillis,
): Effect.Effect<Schedule | undefined> =>
  Effect.gen(function* () {
    const existing = yield* get(db, id)
    if (existing === undefined) return undefined
    const recurrence = patch.recurrence ?? existing.recurrence
    const tz = patch.tzOffsetMin ?? existing.tzOffsetMin
    const enabled = patch.enabled ?? existing.enabled
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
        next_fire_at: computeNext(recurrence, enabled, tz, now),
      })
      .where(eq(CalendarScheduleTable.id, id))
      .run()
      .pipe(Effect.orDie)
    return yield* get(db, id)
  })

export const remove = (db: Db, id: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* db.delete(CalendarScheduleTable).where(eq(CalendarScheduleTable.id, id)).run().pipe(Effect.orDie)
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
 * Record that an occurrence fired. Returns false (no-op) when this exact occurrence was already recorded —
 * the ticker's idempotency guard against overlapping ticks / a restart mid-fire. The unique index on
 * (schedule_id, occurrence_millis) is the hard backstop; onConflictDoNothing covers the check→insert race.
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
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return true
  })

/** Stamp a fire row's session/status after the launch resolves (the claim from recordFire ran first). */
export const setFireOutcome = (
  db: Db,
  input: { readonly scheduleId: string; readonly occurrenceMillis: number; readonly sessionId?: string | null; readonly status: FireStatus },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* db
      .update(CalendarFireTable)
      .set({ session_id: input.sessionId ?? null, status: input.status })
      .where(
        and(
          eq(CalendarFireTable.schedule_id, input.scheduleId),
          eq(CalendarFireTable.occurrence_millis, input.occurrenceMillis),
        ),
      )
      .run()
      .pipe(Effect.orDie)
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
  db
    .select()
    .from(CalendarFireTable)
    .where(eq(CalendarFireTable.schedule_id, scheduleId))
    .all()
    .pipe(Effect.orDie)

export interface Fire {
  readonly id: string
  readonly scheduleId: string
  readonly occurrenceMillis: number
  readonly firedAt: number
  readonly sessionId: string | null
  readonly status: FireStatus
}

const toFire = (row: typeof CalendarFireTable.$inferSelect): Fire => ({
  id: row.id,
  scheduleId: row.schedule_id,
  occurrenceMillis: row.occurrence_millis,
  firedAt: row.fired_at,
  sessionId: row.session_id,
  status: row.status,
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
