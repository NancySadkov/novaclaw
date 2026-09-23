import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
import { ScheduleStore } from "./store"

const withDb = <A>(fn: (db: Database.Interface["db"]) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* DatabaseMigration.apply(db)
    return yield* fn(db)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))

const start = Date.UTC(2025, 2, 10, 1)
const recurrence = { kind: "once" as const, at: start }

describe("officer schedule store", () => {
  test("creates a per-officer definition with default window and heartbeat", async () => {
    const result = await withDb((db) => Effect.gen(function* () {
      const schedule = yield* ScheduleStore.create(db, { agent: "post", recurrence, prompt: "Sort mail" }, start - 1)
      return { schedule, other: yield* ScheduleStore.listForAgent(db, "other") }
    }))
    expect(result.schedule.agent).toBe("post")
    expect(result.schedule.durationMinutes).toBe(60)
    expect(result.schedule.heartbeatMinutes).toBe(10)
    expect(result.schedule.escalateOnFailure).toBe(true)
    expect(result.schedule.nextFireAt).toBe(start)
    expect(result.other).toEqual([])
  })

  test("confirmation belongs to the officer and is idempotent within its window", async () => {
    const result = await withDb((db) => Effect.gen(function* () {
      const schedule = yield* ScheduleStore.create(db, { agent: "post", recurrence, prompt: "Sort mail" }, start - 1)
      const fire = yield* ScheduleStore.openWindow(db, schedule, start, start)
      const wrong = yield* ScheduleStore.confirmForAgent(db, "other", schedule.id, start, start + 1)
      const confirmed = yield* ScheduleStore.confirmForAgent(db, "post", schedule.id, start, start + 2)
      const again = yield* ScheduleStore.confirmForAgent(db, "post", schedule.id, start, start + 3)
      return { fire, wrong, confirmed, again }
    }))
    expect(result.fire.outcome).toBe("pending")
    expect(result.wrong).toBeUndefined()
    expect(result.confirmed?.outcome).toBe("confirmed")
    expect(result.confirmed?.confirmedAt).toBe(start + 2)
    expect(result.again?.confirmedAt).toBe(start + 2)
  })

  test("expired windows reject confirmation and independent overlaps remain active", async () => {
    const result = await withDb((db) => Effect.gen(function* () {
      const first = yield* ScheduleStore.create(db, { agent: "post", recurrence, prompt: "Mail", durationMinutes: 60 }, start - 1)
      const second = yield* ScheduleStore.create(db, { agent: "post", recurrence: { kind: "once", at: start + 10 * 60_000 }, prompt: "Reports", durationMinutes: 60 }, start - 1)
      const firstFire = yield* ScheduleStore.openWindow(db, first, start, start)
      yield* ScheduleStore.openWindow(db, second, start + 10 * 60_000, start + 10 * 60_000)
      yield* ScheduleStore.expireWindow(db, firstFire, start + 60 * 60_000)
      return {
        rejected: yield* ScheduleStore.confirmForAgent(db, "post", first.id, start, start + 60 * 60_000),
        second: yield* ScheduleStore.activeWindows(db, start + 60 * 60_000),
      }
    }))
    expect(result.rejected).toBeUndefined()
    expect(result.second.map(({ schedule }) => schedule.prompt)).toContain("Reports")
  })

  test("retention keeps failed windows until enabled escalation is delivered", async () => {
    const result = await withDb((db) => Effect.gen(function* () {
      const enabled = yield* ScheduleStore.create(db, { agent: "post", recurrence, prompt: "Mail" }, start - 1)
      const optedOut = yield* ScheduleStore.create(db, {
        agent: "post", recurrence, prompt: "Optional", escalateOnFailure: false,
      }, start - 1)
      const failed = yield* ScheduleStore.openWindow(db, enabled, start, start + 60 * 60_000)
      yield* ScheduleStore.openWindow(db, optedOut, start, start + 60 * 60_000)
      const before = yield* ScheduleStore.pruneFires(db, start + 65 * 60_000, 60_000)
      const waiting = yield* ScheduleStore.fires(db, enabled.id)
      yield* ScheduleStore.markEscalated(db, failed, start + 65 * 60_000)
      const after = yield* ScheduleStore.pruneFires(db, start + 66 * 60_000, 60_000)
      return { before, waiting, after, remaining: yield* ScheduleStore.fires(db, enabled.id) }
    }))
    expect(result.before).toBe(1)
    expect(result.waiting).toHaveLength(1)
    expect(result.after).toBe(1)
    expect(result.remaining).toEqual([])
  })
})
