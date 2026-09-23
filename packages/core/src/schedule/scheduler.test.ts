import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
import { ScheduleScheduler } from "./scheduler"
import { ScheduleStore } from "./store"

const withDb = <A>(fn: (db: Database.Interface["db"]) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* DatabaseMigration.apply(db)
    return yield* fn(db)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))

const start = Date.UTC(2025, 2, 10, 1)

describe("officer schedule ticker", () => {
  test("starts once, reminds at anchored ten-minute marks, stops on confirmation", async () => {
    const notices: ScheduleScheduler.Notice[] = []
    const result = await withDb((db) => Effect.gen(function* () {
      const schedule = yield* ScheduleStore.create(db, {
        agent: "post", recurrence: { kind: "once", at: start }, prompt: "Sort and reply to email",
      }, start - 1)
      const deliver: ScheduleScheduler.Deliver = (notice) => Effect.sync(() => { notices.push(notice) })
      const superiorOf = () => Effect.succeed("nova")
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 9 * 60_000)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 10 * 60_000)
      const confirmed = yield* ScheduleStore.confirmForAgent(db, "post", schedule.id, start, start + 11 * 60_000)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 20 * 60_000)
      return { confirmed, fires: yield* ScheduleStore.fires(db, schedule.id) }
    }))
    expect(notices.map((notice) => notice.heartbeatAt)).toEqual([start, start + 10 * 60_000])
    expect(result.confirmed?.outcome).toBe("confirmed")
    expect(result.fires).toHaveLength(1)
    expect(notices[0]?.kind).toBe("heartbeat")
  })

  test("a failed admission retries without advancing and an unconfirmed window escalates", async () => {
    const notices: ScheduleScheduler.Notice[] = []
    let refused = true
    const result = await withDb((db) => Effect.gen(function* () {
      const schedule = yield* ScheduleStore.create(db, {
        agent: "post", recurrence: { kind: "once", at: start }, prompt: "Sort mail", durationMinutes: 20,
      }, start - 1)
      const deliver: ScheduleScheduler.Deliver = (notice) => Effect.gen(function* () {
        if (refused) { refused = false; return yield* Effect.fail("offline") }
        notices.push(notice)
      })
      const superiorOf = () => Effect.succeed("chief")
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start)
      const afterFailure = yield* ScheduleStore.fires(db, schedule.id)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 30_000)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 20 * 60_000)
      return { afterFailure, final: yield* ScheduleStore.fires(db, schedule.id) }
    }))
    expect(result.afterFailure[0]?.lastHeartbeatAt).toBeNull()
    expect(notices.map((notice) => [notice.kind, notice.agent])).toEqual([
      ["heartbeat", "post"], ["escalation", "chief"],
    ])
    expect(result.final[0]?.outcome).toBe("failed")
    expect(result.final[0]?.escalatedAt).toBe(start + 20 * 60_000)
  })

  test("overlapping schedules retain independent windows and opt-out suppresses escalation", async () => {
    const notices: ScheduleScheduler.Notice[] = []
    const result = await withDb((db) => Effect.gen(function* () {
      const first = yield* ScheduleStore.create(db, {
        agent: "post", recurrence: { kind: "once", at: start }, prompt: "Mail", durationMinutes: 60,
      }, start - 1)
      const second = yield* ScheduleStore.create(db, {
        agent: "post", recurrence: { kind: "once", at: start + 10 * 60_000 }, prompt: "Reports",
        durationMinutes: 20, escalateOnFailure: false,
      }, start - 1)
      const deliver: ScheduleScheduler.Deliver = (notice) => Effect.sync(() => { notices.push(notice) })
      const superiorOf = () => Effect.succeed("chief")
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 10 * 60_000)
      const active = yield* ScheduleStore.activeWindows(db, start + 10 * 60_000)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 30 * 60_000)
      return { active, first: yield* ScheduleStore.fires(db, first.id), second: yield* ScheduleStore.fires(db, second.id) }
    }))
    expect(result.active).toHaveLength(2)
    expect(result.first[0]?.outcome).toBe("pending")
    expect(result.second[0]?.outcome).toBe("failed")
    expect(result.second[0]?.escalatedAt).toBeNull()
    expect(notices.filter((notice) => notice.kind === "escalation")).toHaveLength(0)
  })

  test("a recovered instance records each missed range and bounds catch-up per tick", async () => {
    const notices: ScheduleScheduler.Notice[] = []
    const result = await withDb((db) => Effect.gen(function* () {
      const schedule = yield* ScheduleStore.create(db, {
        agent: "post", recurrence: { kind: "daily", time: { hour: 1, minute: 0 } },
        prompt: "Daily mail", durationMinutes: 60,
      }, start - 1)
      const deliver: ScheduleScheduler.Deliver = (notice) => Effect.sync(() => { notices.push(notice) })
      const superiorOf = () => Effect.succeed("chief")
      const late = start + 70 * 24 * 60 * 60_000 + 30 * 60_000
      const firstTick = yield* ScheduleScheduler.tick(db, deliver, superiorOf, late)
      const firstCount = (yield* ScheduleStore.fires(db, schedule.id)).length
      const secondTick = yield* ScheduleScheduler.tick(db, deliver, superiorOf, late)
      return { firstTick, firstCount, secondTick, fires: yield* ScheduleStore.fires(db, schedule.id) }
    }))
    expect(result.firstCount).toBe(ScheduleScheduler.MAX_WINDOWS_OPENED_PER_TICK)
    expect(notices.filter((notice) => notice.kind === "escalation")).toHaveLength(70)
    expect(result.fires.filter((fire) => fire.outcome === "pending")).toHaveLength(1)
    expect(notices.filter((notice) => notice.kind === "heartbeat")).toHaveLength(1)
    expect(result.secondTick.opened).toBe(7)
  })

  test("a confirmation during delivery prevents heartbeat state advancing or further reminders", async () => {
    const notices: ScheduleScheduler.Notice[] = []
    const result = await withDb((db) => Effect.gen(function* () {
      const schedule = yield* ScheduleStore.create(db, {
        agent: "post", recurrence: { kind: "once", at: start }, prompt: "Mail",
      }, start - 1)
      const deliver: ScheduleScheduler.Deliver = (notice) => Effect.gen(function* () {
        notices.push(notice)
        if (notice.kind === "heartbeat") yield* ScheduleStore.confirmForAgent(db, "post", schedule.id, start, start + 1)
      })
      const superiorOf = () => Effect.succeed("chief")
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start)
      yield* ScheduleScheduler.tick(db, deliver, superiorOf, start + 10 * 60_000)
      return yield* ScheduleStore.fires(db, schedule.id)
    }))
    expect(notices).toHaveLength(1)
    expect(result[0]?.outcome).toBe("confirmed")
    expect(result[0]?.lastHeartbeatAt).toBeNull()
  })
})
