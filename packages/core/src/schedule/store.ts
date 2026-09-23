export * as ScheduleStore from "./store"

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, lt, or } from "drizzle-orm"
import { Effect } from "effect"
import { ascending } from "@novaclaw/schema/identifier"
import type { Database } from "../database/database"
import { nextFire, sameRecurrence, type EpochMillis, type Recurrence } from "./recurrence"
import { AgentScheduleTable, AgentScheduleWindowTable } from "./sql"
import { LogSettings } from "../observability/log-settings"

type Db = Database.Interface["db"]
const MINUTE = 60_000
const DEFAULT_DURATION_MINUTES = 60
const DEFAULT_HEARTBEAT_MINUTES = 10
const MAX_DURATION_MINUTES = 1_440
const MAX_HEARTBEAT_MINUTES = 1_440

export interface Schedule {
  readonly id: string
  readonly agent: string
  readonly title: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin: number
  readonly prompt: string
  readonly durationMinutes: number
  readonly heartbeatMinutes: number
  readonly escalateOnFailure: boolean
  readonly enabled: boolean
  readonly nextFireAt: number | null
  readonly lastFiredAt: number | null
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface CreateInput {
  readonly agent: string
  readonly title?: string
  readonly recurrence: Recurrence
  readonly tzOffsetMin?: number
  readonly prompt: string
  readonly durationMinutes?: number
  readonly heartbeatMinutes?: number
  readonly escalateOnFailure?: boolean
  readonly enabled?: boolean
}

export type UpdateInput = Partial<Omit<CreateInput, "agent">>

export interface Fire {
  readonly id: string
  readonly scheduleId: string
  readonly occurrenceMillis: number
  readonly firedAt: number
  readonly windowEndAt: number
  readonly lastHeartbeatAt: number | null
  readonly confirmedAt: number | null
  readonly failedAt: number | null
  readonly escalatedAt: number | null
  readonly nextHeartbeatAt: number | null
  readonly outcome: "pending" | "confirmed" | "failed"
}

const validMinutes = (value: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`Minutes must be between 1 and ${maximum}`)
  return value
}

const toSchedule = (row: typeof AgentScheduleTable.$inferSelect): Schedule => ({
  id: row.id,
  agent: row.agent,
  title: row.title,
  recurrence: JSON.parse(row.recurrence_json) as Recurrence,
  tzOffsetMin: row.tz_offset_min,
  prompt: row.prompt,
  durationMinutes: row.duration_minutes,
  heartbeatMinutes: row.heartbeat_minutes,
  escalateOnFailure: row.escalate_on_failure,
  enabled: row.enabled,
  nextFireAt: row.next_fire_at,
  lastFiredAt: row.last_fired_at,
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

const toFire = (row: typeof AgentScheduleWindowTable.$inferSelect): Fire => ({
  id: row.id,
  scheduleId: row.schedule_id,
  occurrenceMillis: row.occurrence_millis,
  firedAt: row.occurrence_millis,
  windowEndAt: row.window_end_at,
  lastHeartbeatAt: row.last_heartbeat_at,
  confirmedAt: row.confirmed_at,
  failedAt: row.failed_at,
  escalatedAt: row.escalated_at,
  nextHeartbeatAt: row.next_heartbeat_at,
  outcome: row.outcome === "active" ? "pending" : row.outcome,
})

const computeNext = (recurrence: Recurrence, enabled: boolean, tzOffsetMin: number, now: EpochMillis) =>
  enabled ? nextFire(recurrence, now, tzOffsetMin) : null

export const get = (db: Db, id: string): Effect.Effect<Schedule | undefined> =>
  db
    .select()
    .from(AgentScheduleTable)
    .where(eq(AgentScheduleTable.id, id))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => (row ? toSchedule(row) : undefined)),
    )

export const listForAgent = (db: Db, agentID: string): Effect.Effect<Schedule[]> =>
  db
    .select()
    .from(AgentScheduleTable)
    .where(eq(AgentScheduleTable.agent, agentID))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toSchedule)),
    )

export const getForAgent = (db: Db, agentID: string, id: string): Effect.Effect<Schedule | undefined> =>
  db
    .select()
    .from(AgentScheduleTable)
    .where(and(eq(AgentScheduleTable.agent, agentID), eq(AgentScheduleTable.id, id)))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => (row ? toSchedule(row) : undefined)),
    )

export const create = (db: Db, input: CreateInput, now: EpochMillis): Effect.Effect<Schedule> =>
  Effect.gen(function* () {
    const id = "sch_" + ascending()
    const tz = input.tzOffsetMin ?? 0
    const enabled = input.enabled ?? true
    yield* db
      .insert(AgentScheduleTable)
      .values({
        id,
        agent: input.agent,
        title: input.title ?? "",
        recurrence_json: JSON.stringify(input.recurrence),
        tz_offset_min: tz,
        prompt: input.prompt,
        duration_minutes: validMinutes(input.durationMinutes ?? DEFAULT_DURATION_MINUTES, MAX_DURATION_MINUTES),
        heartbeat_minutes: validMinutes(input.heartbeatMinutes ?? DEFAULT_HEARTBEAT_MINUTES, MAX_HEARTBEAT_MINUTES),
        escalate_on_failure: input.escalateOnFailure ?? true,
        enabled,
        next_fire_at: computeNext(input.recurrence, enabled, tz, now),
        last_fired_at: null,
      })
      .run()
      .pipe(Effect.orDie)
    return (yield* get(db, id))!
  })

export const update = (db: Db, id: string, patch: UpdateInput, now: EpochMillis): Effect.Effect<Schedule | undefined> =>
  Effect.gen(function* () {
    const existing = yield* get(db, id)
    if (!existing) return undefined
    const recurrence = patch.recurrence ?? existing.recurrence
    const tz = patch.tzOffsetMin ?? existing.tzOffsetMin
    const enabled = patch.enabled ?? existing.enabled
    const timingChanged =
      !sameRecurrence(recurrence, existing.recurrence) || tz !== existing.tzOffsetMin || enabled !== existing.enabled
    yield* db
      .update(AgentScheduleTable)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.recurrence !== undefined ? { recurrence_json: JSON.stringify(recurrence) } : {}),
        ...(patch.durationMinutes !== undefined
          ? { duration_minutes: validMinutes(patch.durationMinutes, MAX_DURATION_MINUTES) }
          : {}),
        ...(patch.heartbeatMinutes !== undefined
          ? { heartbeat_minutes: validMinutes(patch.heartbeatMinutes, MAX_HEARTBEAT_MINUTES) }
          : {}),
        ...(patch.escalateOnFailure !== undefined ? { escalate_on_failure: patch.escalateOnFailure } : {}),
        tz_offset_min: tz,
        enabled,
        next_fire_at: timingChanged ? computeNext(recurrence, enabled, tz, now) : existing.nextFireAt,
      })
      .where(eq(AgentScheduleTable.id, id))
      .run()
      .pipe(Effect.orDie)
    return yield* get(db, id)
  })

export const updateForAgent = (db: Db, agentID: string, id: string, patch: UpdateInput, now: EpochMillis) =>
  getForAgent(db, agentID, id).pipe(
    Effect.flatMap((existing) => (existing ? update(db, id, patch, now) : Effect.succeed(undefined))),
  )

export const remove = (db: Db, id: string): Effect.Effect<void> =>
  db.delete(AgentScheduleTable).where(eq(AgentScheduleTable.id, id)).run().pipe(Effect.orDie, Effect.asVoid)

export const removeForAgent = (db: Db, agentID: string, id: string): Effect.Effect<boolean> =>
  getForAgent(db, agentID, id).pipe(
    Effect.flatMap((existing) => (existing ? remove(db, id).pipe(Effect.as(true)) : Effect.succeed(false))),
  )

export const due = (db: Db, now: EpochMillis): Effect.Effect<Schedule[]> =>
  db
    .select()
    .from(AgentScheduleTable)
    .where(and(eq(AgentScheduleTable.enabled, true), lte(AgentScheduleTable.next_fire_at, now)))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toSchedule)),
    )

export const openWindow = (
  db: Db,
  schedule: Schedule,
  occurrenceMillis: number,
  now: EpochMillis,
): Effect.Effect<Fire> =>
  Effect.gen(function* () {
    const windowEndAt = occurrenceMillis + schedule.durationMinutes * MINUTE
    yield* db
      .insert(AgentScheduleWindowTable)
      .values({
        id: "win_" + ascending(),
        schedule_id: schedule.id,
        occurrence_millis: occurrenceMillis,
        window_end_at: windowEndAt,
        next_heartbeat_at: now < windowEndAt ? now : null,
        outcome: now < windowEndAt ? "active" : "failed",
        failed_at: now < windowEndAt ? null : now,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const row = yield* db
      .select()
      .from(AgentScheduleWindowTable)
      .where(
        and(
          eq(AgentScheduleWindowTable.schedule_id, schedule.id),
          eq(AgentScheduleWindowTable.occurrence_millis, occurrenceMillis),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return toFire(row!)
  })

export const advance = (db: Db, id: string): Effect.Effect<Schedule | undefined> =>
  Effect.gen(function* () {
    const existing = yield* get(db, id)
    if (!existing) return undefined
    yield* db
      .update(AgentScheduleTable)
      .set({
        last_fired_at: existing.nextFireAt,
        next_fire_at:
          existing.nextFireAt === null
            ? null
            : computeNext(existing.recurrence, existing.enabled, existing.tzOffsetMin, existing.nextFireAt),
      })
      .where(
        and(
          eq(AgentScheduleTable.id, id),
          existing.nextFireAt === null
            ? isNull(AgentScheduleTable.next_fire_at)
            : eq(AgentScheduleTable.next_fire_at, existing.nextFireAt),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    return yield* get(db, id)
  })

export const activeWindows = (db: Db, now: EpochMillis): Effect.Effect<Array<{ schedule: Schedule; fire: Fire }>> =>
  db
    .select({ schedule: AgentScheduleTable, fire: AgentScheduleWindowTable })
    .from(AgentScheduleWindowTable)
    .innerJoin(AgentScheduleTable, eq(AgentScheduleWindowTable.schedule_id, AgentScheduleTable.id))
    .where(and(eq(AgentScheduleWindowTable.outcome, "active"), lte(AgentScheduleWindowTable.occurrence_millis, now)))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => ({ schedule: toSchedule(row.schedule), fire: toFire(row.fire) }))),
    )

export const claimHeartbeat = (db: Db, fire: Fire, intervalMinutes: number, now: EpochMillis): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (now >= fire.windowEndAt || fire.nextHeartbeatAt === null || now < fire.nextHeartbeatAt) return false
    const changed = yield* db
      .update(AgentScheduleWindowTable)
      .set({
        last_heartbeat_at: now,
        next_heartbeat_at: Math.min(
          fire.windowEndAt,
          fire.occurrenceMillis +
            (Math.floor((now - fire.occurrenceMillis) / (intervalMinutes * MINUTE)) + 1) * intervalMinutes * MINUTE,
        ),
      })
      .where(
        and(
          eq(AgentScheduleWindowTable.id, fire.id),
          eq(AgentScheduleWindowTable.outcome, "active"),
          eq(AgentScheduleWindowTable.next_heartbeat_at, fire.nextHeartbeatAt),
        ),
      )
      .returning({ id: AgentScheduleWindowTable.id })
      .all()
      .pipe(Effect.orDie)
    return changed.length > 0
  })

export const expireWindow = (db: Db, fire: Fire, now: EpochMillis): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (now < fire.windowEndAt) return false
    const changed = yield* db
      .update(AgentScheduleWindowTable)
      .set({ outcome: "failed", failed_at: now, next_heartbeat_at: null })
      .where(and(eq(AgentScheduleWindowTable.id, fire.id), eq(AgentScheduleWindowTable.outcome, "active")))
      .returning({ id: AgentScheduleWindowTable.id })
      .all()
      .pipe(Effect.orDie)
    return changed.length > 0
  })

export const failedUnescalated = (db: Db): Effect.Effect<Array<{ schedule: Schedule; fire: Fire }>> =>
  db
    .select({ schedule: AgentScheduleTable, fire: AgentScheduleWindowTable })
    .from(AgentScheduleWindowTable)
    .innerJoin(AgentScheduleTable, eq(AgentScheduleWindowTable.schedule_id, AgentScheduleTable.id))
    .where(
      and(
        eq(AgentScheduleWindowTable.outcome, "failed"),
        isNull(AgentScheduleWindowTable.escalated_at),
        eq(AgentScheduleTable.escalate_on_failure, true),
      ),
    )
    .limit(64)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => ({ schedule: toSchedule(row.schedule), fire: toFire(row.fire) }))),
    )

export const markEscalated = (db: Db, fire: Fire, now: EpochMillis): Effect.Effect<void> =>
  db
    .update(AgentScheduleWindowTable)
    .set({ escalated_at: now })
    .where(
      and(
        eq(AgentScheduleWindowTable.id, fire.id),
        eq(AgentScheduleWindowTable.outcome, "failed"),
        isNull(AgentScheduleWindowTable.escalated_at),
      ),
    )
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

export const confirmForAgent = (
  db: Db,
  agentID: string,
  scheduleID: string,
  occurrenceMillis: number,
  now: EpochMillis,
): Effect.Effect<Fire | undefined> =>
  Effect.gen(function* () {
    const schedule = yield* getForAgent(db, agentID, scheduleID)
    if (!schedule) return undefined
    const row = yield* db
      .select()
      .from(AgentScheduleWindowTable)
      .where(
        and(
          eq(AgentScheduleWindowTable.schedule_id, scheduleID),
          eq(AgentScheduleWindowTable.occurrence_millis, occurrenceMillis),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row || row.outcome === "failed" || (row.outcome === "active" && now >= row.window_end_at)) return undefined
    if (row.outcome === "confirmed") return toFire(row)
    const updated = yield* db
      .update(AgentScheduleWindowTable)
      .set({ outcome: "confirmed", confirmed_at: now, next_heartbeat_at: null })
      .where(and(eq(AgentScheduleWindowTable.id, row.id), eq(AgentScheduleWindowTable.outcome, "active")))
      .returning()
      .get()
      .pipe(Effect.orDie)
    return updated ? toFire(updated) : undefined
  })

export const fires = (db: Db, scheduleId: string): Effect.Effect<Fire[]> =>
  db
    .select()
    .from(AgentScheduleWindowTable)
    .where(eq(AgentScheduleWindowTable.schedule_id, scheduleId))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toFire)),
    )

export const recentFires = (db: Db, limit = 20): Effect.Effect<Fire[]> =>
  db
    .select()
    .from(AgentScheduleWindowTable)
    .orderBy(desc(AgentScheduleWindowTable.occurrence_millis))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toFire)),
    )

export const recentFiresForAgent = (db: Db, agentID: string, limit = 20): Effect.Effect<Fire[]> =>
  db
    .select({ fire: AgentScheduleWindowTable })
    .from(AgentScheduleWindowTable)
    .innerJoin(AgentScheduleTable, eq(AgentScheduleWindowTable.schedule_id, AgentScheduleTable.id))
    .where(eq(AgentScheduleTable.agent, agentID))
    .orderBy(desc(AgentScheduleWindowTable.occurrence_millis))
    .limit(limit)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => toFire(row.fire))),
    )

export const pruneFires = (db: Db, now: EpochMillis, retentionMs = LogSettings.maxAgeMs()): Effect.Effect<number> =>
  Effect.gen(function* () {
    const stale = yield* db
      .select({ id: AgentScheduleWindowTable.id })
      .from(AgentScheduleWindowTable)
      .innerJoin(AgentScheduleTable, eq(AgentScheduleWindowTable.schedule_id, AgentScheduleTable.id))
      .where(
        and(
          lt(AgentScheduleWindowTable.window_end_at, now - retentionMs),
          or(
            eq(AgentScheduleWindowTable.outcome, "confirmed"),
            and(
              eq(AgentScheduleWindowTable.outcome, "failed"),
              or(eq(AgentScheduleTable.escalate_on_failure, false), isNotNull(AgentScheduleWindowTable.escalated_at)),
            ),
          ),
        ),
      )
      .orderBy(asc(AgentScheduleWindowTable.window_end_at))
      .limit(500)
      .all()
      .pipe(Effect.orDie)
    if (stale.length === 0) return 0
    yield* db
      .delete(AgentScheduleWindowTable)
      .where(
        inArray(
          AgentScheduleWindowTable.id,
          stale.map((row) => row.id),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    return stale.length
  })
