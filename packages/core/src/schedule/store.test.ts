// CalendarStore (P1) over an in-memory migrated DB. Also proves the add_calendar migration applies
// (DatabaseMigration.apply runs it). Pins: create computes next_fire_at, disabled -> null, update
// recomputes, due filters by enabled + past next_fire_at, recordFire is idempotent, advance rolls forward.
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
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

  test("update of a missing id returns undefined", async () => {
    const result = await withDb((db) => CalendarStore.update(db, "cal_nope", { title: "x" }, MAR10_0800))
    expect(result).toBeUndefined()
  })

  test("remove deletes the schedule", async () => {
    const after = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "x" }, MAR10_0800)
        yield* CalendarStore.remove(db, s.id)
        return yield* CalendarStore.list(db)
      }),
    )
    expect(after).toHaveLength(0)
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
        yield* CalendarStore.recordFire(db, { scheduleId: a.id, occurrenceMillis: 100, firedAt: 100, status: "spawned" })
        yield* CalendarStore.recordFire(db, { scheduleId: b.id, occurrenceMillis: 200, firedAt: 200, status: "error" })
        return yield* CalendarStore.recentFires(db)
      }),
    )
    expect(out).toHaveLength(2)
    expect(out[0]!.firedAt).toBe(200) // newest first
    expect(out[0]!.status).toBe("error")
    expect(out[1]!.firedAt).toBe(100)
  })
})
