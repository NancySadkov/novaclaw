// CalendarScheduler.tick (P2) over an in-memory migrated DB with a FAKE launcher. Pins: a due schedule
// fires once + advances; an already-claimed occurrence is not re-launched; future/disabled are untouched;
// catch-up fires once and jumps to a future occurrence; a launch failure is isolated (error + still advances).
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
import { CalendarScheduler } from "./scheduler"
import { CalendarStore } from "./store"
import type { Recurrence } from "./recurrence"
import type { SessionV2 } from "../session"

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
const MAR10_1000 = Date.UTC(2025, 2, 10, 10, 0)
const MAR11_0900 = Date.UTC(2025, 2, 11, 9, 0)

/** A launcher that records its calls and returns a fixed session id (or fails). */
const recorder = (id: string | null, fail = false) => {
  const calls: CalendarScheduler.LaunchInput[] = []
  const launch: CalendarScheduler.Launch = (input) => {
    calls.push(input)
    return fail ? Effect.fail(new Error("launch boom")) : Effect.succeed(id)
  }
  return { launch, calls }
}

describe("CalendarScheduler.tick", () => {
  test("fires a due schedule once, records the session, advances next_fire_at", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "hi" }, MAR10_0800)
        const { launch, calls } = recorder("ses_1")
        const result = yield* CalendarScheduler.tick(db, launch, MAR10_1000)
        const after = yield* CalendarStore.get(db, s.id)
        const fires = yield* CalendarStore.fires(db, s.id)
        return { result, calls, after, fires }
      }),
    )
    expect(out.result).toEqual({ fired: 1, skipped: 0 })
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0]!.occurrenceMillis).toBe(MAR10_0900)
    expect(out.after?.nextFireAt).toBe(MAR11_0900) // rolled forward
    expect(out.after?.lastFiredAt).toBe(MAR10_1000)
    expect(out.fires).toHaveLength(1)
    expect(out.fires[0]!.session_id).toBe("ses_1")
    expect(out.fires[0]!.status).toBe("spawned")
  })

  test("does not re-fire on a second tick (already advanced past the occurrence)", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        yield* CalendarStore.create(db, { recurrence: daily9, prompt: "hi" }, MAR10_0800)
        const { launch, calls } = recorder("ses_1")
        yield* CalendarScheduler.tick(db, launch, MAR10_1000)
        const second = yield* CalendarScheduler.tick(db, launch, MAR10_1000)
        return { second, calls }
      }),
    )
    expect(out.second).toEqual({ fired: 0, skipped: 0 })
    expect(out.calls).toHaveLength(1) // launched exactly once
  })

  test("an occurrence already claimed in the fire ledger is not re-launched", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "hi" }, MAR10_0800)
        // Simulate a prior cycle having already fired this exact occurrence.
        yield* CalendarStore.recordFire(db, {
          scheduleId: s.id,
          occurrenceMillis: MAR10_0900,
          firedAt: MAR10_0900,
          status: "spawned",
        })
        const { launch, calls } = recorder("ses_2")
        const result = yield* CalendarScheduler.tick(db, launch, MAR10_1000)
        const after = yield* CalendarStore.get(db, s.id)
        return { result, calls, after }
      }),
    )
    expect(out.calls).toHaveLength(0) // NOT launched
    expect(out.result).toEqual({ fired: 0, skipped: 1 })
    expect(out.after?.nextFireAt).toBe(MAR11_0900) // still advanced past it
  })

  test("future and disabled schedules are untouched", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        // future: next_fire_at is tomorrow 09:00 relative to a `now` before it
        yield* CalendarStore.create(db, { recurrence: daily9, prompt: "future" }, MAR10_0900)
        // disabled: next_fire_at null
        yield* CalendarStore.create(db, { recurrence: daily9, prompt: "off", enabled: false }, MAR10_0800)
        const { launch, calls } = recorder("ses_x")
        const result = yield* CalendarScheduler.tick(db, launch, MAR10_1000)
        return { result, calls }
      }),
    )
    expect(out.calls).toHaveLength(0)
    expect(out.result).toEqual({ fired: 0, skipped: 0 })
  })

  test("catch-up fires once and jumps to a future occurrence", async () => {
    // Created a week ago; the instance was 'down'. next_fire_at is a week in the past.
    const weekAgo0800 = Date.UTC(2025, 2, 3, 8, 0)
    const nowMar10_1200 = Date.UTC(2025, 2, 10, 12, 0)
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "catchup" }, weekAgo0800)
        const { launch, calls } = recorder("ses_c")
        const result = yield* CalendarScheduler.tick(db, launch, nowMar10_1200)
        const after = yield* CalendarStore.get(db, s.id)
        return { result, calls, after }
      }),
    )
    expect(out.result).toEqual({ fired: 1, skipped: 0 })
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0]!.occurrenceMillis).toBe(Date.UTC(2025, 2, 3, 9, 0)) // the ORIGINAL due occurrence
    expect(out.after!.nextFireAt!).toBeGreaterThan(nowMar10_1200) // jumped to the future, no replay
    expect(out.after?.nextFireAt).toBe(MAR11_0900)
  })

  test("a launch failure is isolated: recorded as error, schedule still advances", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "boom" }, MAR10_0800)
        const { launch } = recorder(null, true)
        const result = yield* CalendarScheduler.tick(db, launch, MAR10_1000)
        const after = yield* CalendarStore.get(db, s.id)
        const fires = yield* CalendarStore.fires(db, s.id)
        return { result, after, fires }
      }),
    )
    expect(out.result).toEqual({ fired: 0, skipped: 1 })
    expect(out.fires[0]!.status).toBe("error")
    expect(out.after?.nextFireAt).toBe(MAR11_0900) // advanced despite the failure
  })
})

describe("CalendarScheduler.makeLaunch", () => {
  // A fake SessionV2 (only the two methods makeLaunch uses) that records its calls.
  const fakeSessions = (created: unknown[], prompted: unknown[]) =>
    ({
      create: (input: unknown) =>
        Effect.sync(() => {
          created.push(input)
          return { id: "ses_new" }
        }),
      prompt: (input: unknown) =>
        Effect.sync(() => {
          prompted.push(input)
          return {}
        }),
    }) as unknown as Pick<SessionV2.Interface, "create" | "prompt">

  const sample = (over: Partial<CalendarStore.Schedule> = {}): CalendarStore.Schedule => ({
    id: "cal_1",
    title: "NY Greeting",
    recurrence: { kind: "yearly", time: { hour: 9, minute: 0 }, month: 1, day: 1 },
    tzOffsetMin: 0,
    prompt: "Congratulate clients",
    agent: null,
    model: null,
    location: null,
    permissionMode: null,
    enabled: true,
    nextFireAt: 123,
    lastFiredAt: null,
    timeCreated: 0,
    timeUpdated: 0,
    ...over,
  })

  test("creates a goal-oriented session at the instance home and queues the prompt", async () => {
    const created: any[] = []
    const prompted: any[] = []
    const id = await Effect.runPromise(
      CalendarScheduler.makeLaunch(fakeSessions(created, prompted), "/home/nancy")({
        schedule: sample(),
        occurrenceMillis: 123,
        firedAt: 130,
      }),
    )
    expect(id).toBe("ses_new")
    expect(created[0].location.directory).toBe("/home/nancy")
    expect(created[0].type).toBe("goal-oriented")
    expect(created[0].title).toBe("NY Greeting")
    expect(created[0].metadata.calendarScheduleID).toBe("cal_1")
    expect(created[0].metadata.occurrenceMillis).toBe(123)
    expect(prompted[0].sessionID).toBe("ses_new")
    expect(prompted[0].prompt.text).toBe("Congratulate clients")
    expect(prompted[0].delivery).toBe("queue")
  })

  test("uses the schedule's own location when set", async () => {
    const created: any[] = []
    const prompted: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(fakeSessions(created, prompted), "/home/nancy")({
        schedule: sample({ location: "/srv/clients" }),
        occurrenceMillis: 1,
        firedAt: 1,
      }),
    )
    expect(created[0].location.directory).toBe("/srv/clients")
  })

  test("resolves a per-schedule model string + agent into refs", async () => {
    const created: any[] = []
    const prompted: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(fakeSessions(created, prompted), "/home/nancy")({
        schedule: sample({ model: "dgx-spark/qwen3.6-35b", agent: "build", permissionMode: "bypass" }),
        occurrenceMillis: 1,
        firedAt: 1,
      }),
    )
    expect(created[0].model.id).toBe("qwen3.6-35b")
    expect(created[0].model.providerID).toBe("dgx-spark")
    expect(created[0].agent).toBe("build")
    expect(created[0].permissionMode).toBe("bypass")
  })

  test("uses the schedule's own work folder (location) when set", async () => {
    const created: any[] = []
    const prompted: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(fakeSessions(created, prompted), "/home/nancy")({
        schedule: sample({ location: "/srv/clients" }),
        occurrenceMillis: 1,
        firedAt: 1,
      }),
    )
    expect(created[0].location.directory).toBe("/srv/clients")
  })

  test("omits model/agent/permission when the schedule has none (inherit instance default)", async () => {
    const created: any[] = []
    const prompted: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(fakeSessions(created, prompted), "/home/nancy")({
        schedule: sample(),
        occurrenceMillis: 1,
        firedAt: 1,
      }),
    )
    expect("model" in created[0]).toBe(false)
    expect("agent" in created[0]).toBe(false)
    expect("permissionMode" in created[0]).toBe(false)
  })
})
