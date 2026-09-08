// CalendarStore (P1) over an in-memory migrated DB. Also proves the add_calendar migration applies
// (DatabaseMigration.apply runs it). Pins: create computes next_fire_at, disabled -> null, update
// recomputes, due filters by enabled + past next_fire_at, recordFire is idempotent, advance rolls forward.
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
import { SessionSchema } from "../session/schema"
import { SessionExecutionTable, SessionTable } from "../session/sql"
import { CalendarStore } from "./store"
import type { Recurrence } from "./recurrence"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const withDb = <A>(fn: (db: Database.Interface["db"]) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      return yield* fn(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const daily9: Recurrence = { kind: "daily", time: { hour: 9, minute: 0 } }
const MAR10_0800 = Date.UTC(2025, 2, 10, 8, 0)
const MAR10_0900 = Date.UTC(2025, 2, 10, 9, 0)
const MAR11_0900 = Date.UTC(2025, 2, 11, 9, 0)

describe("CalendarStore", () => {
  test("create computes next_fire_at and round-trips via get/list", async () => {
    const { created, got, all } = await withDb((db) =>
      Effect.gen(function* () {
        const created = yield* CalendarStore.create(
          db,
          { title: "Morning", recurrence: daily9, prompt: "good morning" },
          MAR10_0800,
        )
        const got = yield* CalendarStore.get(db, created.id)
        const all = yield* CalendarStore.list(db)
        return { created, got, all }
      }),
    )
    expect(created.title).toBe("Morning")
    expect(created.recurrence).toEqual(daily9)
    expect(created.enabled).toBe(true)
    expect(created.nextFireAt).toBe(MAR10_0900)
    expect(created.lastFiredAt).toBeNull()
    expect(got?.id).toBe(created.id)
    expect(got?.prompt).toBe("good morning")
    expect(all).toHaveLength(1)
  })

  test("created disabled -> next_fire_at is null", async () => {
    const created = await withDb((db) =>
      CalendarStore.create(db, { recurrence: daily9, prompt: "x", enabled: false }, MAR10_0800),
    )
    expect(created.enabled).toBe(false)
    expect(created.nextFireAt).toBeNull()
  })

  test("update recomputes next_fire_at; disable clears it, re-enable restores it", async () => {
    const { disabled, reenabled } = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        const disabled = yield* CalendarStore.update(db, s.id, { enabled: false }, MAR10_0800)
        const reenabled = yield* CalendarStore.update(db, s.id, { enabled: true }, MAR10_0800)
        return { disabled, reenabled }
      }),
    )
    expect(disabled?.nextFireAt).toBeNull()
    expect(reenabled?.nextFireAt).toBe(MAR10_0900)
  })

  test("update patches permissionMode and leaves untouched fields alone", async () => {
    const { before, after } = await withDb((db) =>
      Effect.gen(function* () {
        const before = yield* CalendarStore.create(
          db,
          { recurrence: daily9, prompt: "keep me", title: "Keep", permissionMode: "bypass" },
          MAR10_0800,
        )
        const after = yield* CalendarStore.update(db, before.id, { permissionMode: "plan" }, MAR10_0800)
        return { before, after }
      }),
    )
    expect(before.permissionMode).toBe("bypass")
    expect(after?.permissionMode).toBe("plan")
    // A one-field patch must not clobber the rest.
    expect(after?.prompt).toBe("keep me")
    expect(after?.title).toBe("Keep")
    expect(after?.nextFireAt).toBe(MAR10_0900)
  })

  // An ordinary edit must not cancel today's run. The editor round-trips the whole form on save, so the
  // patch that renames a task carries an identical recurrence and offset — which is why the test here is
  // whether the timing VALUES changed, not whether their fields were present in the patch.
  test("a patch that changes nothing about WHEN it fires leaves a due occurrence due", async () => {
    const tenSecondsLate = MAR10_0900 + 10_000
    const { renamed, stillDue } = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, title: "Backup", prompt: "x" }, MAR10_0800)
        // The 09:00 occurrence is due and the ticker has not reached it yet.
        const renamed = yield* CalendarStore.update(
          db,
          s.id,
          { title: "Nightly backup", recurrence: daily9, tzOffsetMin: 0, enabled: true },
          tenSecondsLate,
        )
        const stillDue = yield* CalendarStore.due(db, tenSecondsLate)
        return { renamed, stillDue }
      }),
    )
    expect(renamed?.title).toBe("Nightly backup")
    expect(renamed?.nextFireAt).toBe(MAR10_0900) // NOT rolled to tomorrow
    expect(stillDue).toHaveLength(1)
  })

  test("a patch that really reschedules DOES move the next fire", async () => {
    const tenSecondsLate = MAR10_0900 + 10_000
    const moved = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        return yield* CalendarStore.update(
          db,
          s.id,
          { recurrence: { kind: "daily", time: { hour: 18, minute: 0 } } },
          tenSecondsLate,
        )
      }),
    )
    expect(moved?.nextFireAt).toBe(Date.UTC(2025, 2, 10, 18, 0))
  })

  test("a patch that only moves the offset also reschedules", async () => {
    const moved = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        return yield* CalendarStore.update(db, s.id, { tzOffsetMin: 120 }, MAR10_0800)
      }),
    )
    // 09:00 wall at UTC+2 on Mar 10 is 07:00 UTC, already behind `now` — so the next one is Mar 11.
    expect(moved?.nextFireAt).toBe(MAR11_0900 - 120 * 60_000)
  })

  test("update of a missing id returns undefined", async () => {
    const result = await withDb((db) => CalendarStore.update(db, "cal_nope", { title: "x" }, MAR10_0800))
    expect(result).toBeUndefined()
  })

  test("remove deletes the schedule and its fire history", async () => {
    const after = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        yield* CalendarStore.recordFire(db, {
          scheduleId: s.id,
          occurrenceMillis: MAR10_0900,
          firedAt: MAR10_0900,
          status: "spawned",
        })
        yield* CalendarStore.remove(db, s.id)
        return { schedules: yield* CalendarStore.list(db), fires: yield* CalendarStore.fires(db, s.id) }
      }),
    )
    expect(after.schedules).toHaveLength(0)
    expect(after.fires).toHaveLength(0)
  })

  test("due returns only enabled schedules whose next_fire_at is at/before now", async () => {
    const { atFire, beforeFire, disabledExcluded } = await withDb((db) =>
      Effect.gen(function* () {
        // next_fire_at = MAR10_0900
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        // a disabled schedule (next_fire_at null) must never surface
        yield* CalendarStore.create(db, { recurrence: daily9, prompt: "y", enabled: false }, MAR10_0800)
        const beforeFire = yield* CalendarStore.due(db, MAR10_0900 - 1)
        const atFire = yield* CalendarStore.due(db, MAR10_0900)
        return { atFire, beforeFire, disabledExcluded: s.id }
      }),
    )
    expect(beforeFire).toHaveLength(0)
    expect(atFire).toHaveLength(1)
    expect(atFire[0]!.id).toBe(disabledExcluded)
  })

  test("recordFire is idempotent per occurrence", async () => {
    const { first, second, history } = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        const first = yield* CalendarStore.recordFire(db, {
          scheduleId: s.id,
          occurrenceMillis: MAR10_0900,
          firedAt: MAR10_0900,
          sessionId: "ses_1",
          status: "spawned",
        })
        const second = yield* CalendarStore.recordFire(db, {
          scheduleId: s.id,
          occurrenceMillis: MAR10_0900,
          firedAt: MAR10_0900 + 5,
          status: "spawned",
        })
        const history = yield* CalendarStore.fires(db, s.id)
        return { first, second, history }
      }),
    )
    expect(first).toBe(true)
    expect(second).toBe(false) // same occurrence -> no double fire
    expect(history).toHaveLength(1)
    expect(history[0]!.session_id).toBe("ses_1")
  })

  test("advance stamps last_fired_at and rolls next_fire_at to the next occurrence", async () => {
    const advanced = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        return yield* CalendarStore.advance(db, s.id, MAR10_0900)
      }),
    )
    expect(advanced?.lastFiredAt).toBe(MAR10_0900)
    expect(advanced?.nextFireAt).toBe(MAR11_0900) // strictly after the fired occurrence
  })

  test("recentFires returns fires across schedules, newest first", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const a = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "a" }, MAR10_0800)
        const b = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "b" }, MAR10_0800)
        yield* CalendarStore.recordFire(db, {
          scheduleId: a.id,
          occurrenceMillis: 100,
          firedAt: 100,
          status: "spawned",
        })
        yield* CalendarStore.recordFire(db, { scheduleId: b.id, occurrenceMillis: 200, firedAt: 200, status: "error" })
        return yield* CalendarStore.recentFires(db)
      }),
    )
    expect(out).toHaveLength(2)
    expect(out[0]!.firedAt).toBe(200) // newest first
    expect(out[0]!.status).toBe("error")
    expect(out[1]!.firedAt).toBe(100)
  })

  test("pruneFires removes old history but keeps the schedule's current occurrence", async () => {
    const now = Date.UTC(2025, 6, 1)
    const retention = 30 * 24 * 60 * 60_000
    const old = now - retention - 1
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        // The schedule's next fire is still MAR10_0900. This old claim must survive so recovery can
        // still decide whether it is an abandoned run rather than launching a duplicate.
        yield* CalendarStore.recordFire(db, {
          scheduleId: s.id,
          occurrenceMillis: MAR10_0900,
          firedAt: old,
          status: "skipped",
        })
        yield* CalendarStore.recordFire(db, {
          scheduleId: s.id,
          occurrenceMillis: MAR10_0900 - 24 * 60 * 60_000,
          firedAt: old - 1,
          status: "spawned",
        })
        const removed = yield* CalendarStore.pruneFires(db, now, retention)
        return { removed, fires: yield* CalendarStore.fires(db, s.id) }
      }),
    )
    expect(out.removed).toBe(1)
    expect(out.fires).toHaveLength(1)
    expect(out.fires[0]!.status).toBe("skipped")
  })

  test("reconcileFireOutcomes projects terminal session states once", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const schedule = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        const states = [
          ["ses_succeeded", "settled"],
          ["ses_failed", "failed"],
          ["ses_interrupted", "interrupted"],
          ["ses_busy", "busy"],
        ] as const
        yield* db
          .insert(SessionTable)
          .values(
            states.map(([id]) => ({
              id: SessionSchema.ID.make(id),
              slug: id,
              directory: "/tmp",
              title: id,
              version: "test",
              time_created: 1,
              time_updated: 1,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionExecutionTable)
          .values(
            states.map(([id, state]) => ({
              session_id: SessionSchema.ID.make(id),
              attempt_id: `attempt_${id}`,
              generation: 1,
              owner_id: "test",
              state,
              phase: "drain" as const,
              heartbeat_at: 1,
              started_at: 1,
              time_updated: 1,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        for (const [index, [id]] of states.entries()) {
          yield* CalendarStore.recordFire(db, {
            scheduleId: schedule.id,
            occurrenceMillis: MAR10_0900 + index,
            firedAt: MAR10_0900 + index,
            sessionId: id,
            status: "spawned",
          })
        }
        const changed = yield* CalendarStore.reconcileFireOutcomes(db)
        const changedAgain = yield* CalendarStore.reconcileFireOutcomes(db)
        return { changed, changedAgain, fires: yield* CalendarStore.recentFires(db) }
      }),
    )
    expect(out.changed).toBe(3)
    expect(out.changedAgain).toBe(0)
    const bySession = new Map(out.fires.map((fire) => [fire.sessionId, fire.outcome]))
    expect(bySession.get("ses_succeeded")).toBe("succeeded")
    expect(bySession.get("ses_failed")).toBe("failed")
    expect(bySession.get("ses_interrupted")).toBe("interrupted")
    expect(bySession.get("ses_busy")).toBe("pending")
  })
})
