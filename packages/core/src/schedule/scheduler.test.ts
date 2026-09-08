// CalendarScheduler.tick (P2) over an in-memory migrated DB with a FAKE launcher. Pins: a due schedule
// fires once + advances; an already-claimed occurrence is not re-launched; future/disabled are untouched;
// catch-up fires once and jumps to a future occurrence; a launch failure is isolated (error + still advances).
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
import { AppNodeBuilder } from "../effect/app-node-builder"
import { CapabilityRegistry } from "../effect/capability-registry"
import { LayerNode } from "../effect/layer-node"
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

describe("CalendarScheduler capability", () => {
  test("keeps the core alive, caches a refusal, and retries in place", async () => {
    let refuse = true
    let builds = 0
    const constructor = Layer.effect(
      CalendarScheduler.Service,
      Effect.sync(() => {
        builds++
        if (refuse) throw new Error("forced calendar scheduler constructor defect")
        return CalendarScheduler.Service.of({ running: true })
      }),
    )
    const graph = AppNodeBuilder.build(LayerNode.group([CapabilityRegistry.node, CalendarScheduler.capabilityNode]), [
      [CalendarScheduler.node, constructor],
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* CapabilityRegistry.Service
        const capability = yield* CalendarScheduler.CapabilityService
        const before = yield* registry.inspect()
        const first = yield* capability.get
        const second = yield* capability.get
        refuse = false
        const retried = yield* registry.retry("calendar-scheduler")
        const after = yield* capability.get
        return { before, first, second, retried, after, core: "alive" }
      }).pipe(Effect.provide(graph)),
    )

    expect(result.before).toEqual([{ name: "calendar-scheduler", status: { state: "idle" } }])
    expect(result.first).toMatchObject({
      ok: false,
      error: { capability: "calendar-scheduler", kind: "failed" },
    })
    expect(result.second).toEqual(result.first)
    expect(result.retried.state).toBe("ready")
    expect(result.after).toEqual({ ok: true, value: { running: true } })
    expect(result.core).toBe("alive")
    expect(builds).toBe(2)
  })
})

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

  // A process KILLED between claiming an occurrence and rolling the schedule forward. The claim it left
  // behind is the real artefact of that death, so the crash is simulated by making it through the
  // production primitive and then doing nothing else — exactly what the dead process managed.
  const LEASE = CalendarStore.RECLAIM_ABANDONED_AFTER_MINUTES * 60_000
  const CLAIMED_AT = MAR10_0900 + 30_000

  const crashedMidFire = (db: Database.Interface["db"]) =>
    Effect.gen(function* () {
      const s = yield* CalendarStore.create(db, { recurrence: daily9, prompt: "backup" }, MAR10_0800)
      const claim = yield* CalendarStore.claimOccurrence(db, {
        scheduleId: s.id,
        occurrenceMillis: MAR10_0900,
        now: CLAIMED_AT,
      })
      return { s, claim }
    })

  test("a crashed claim is never recorded as a run that happened", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const { s, claim } = yield* crashedMidFire(db)
        const fires = yield* CalendarStore.fires(db, s.id)
        return { claim, fires }
      }),
    )
    expect(out.claim.kind).toBe("claimed")
    expect(out.fires).toHaveLength(1)
    expect(out.fires[0]!.status).not.toBe("spawned") // the lie this replaces
    expect(out.fires[0]!.session_id).toBeNull()
  })

  test("a live claim holds the occurrence: not re-launched, and NOT rolled past", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const { s } = yield* crashedMidFire(db)
        const { launch, calls } = recorder("ses_r")
        const result = yield* CalendarScheduler.tick(db, launch, CLAIMED_AT + 60_000)
        const after = yield* CalendarStore.get(db, s.id)
        return { result, calls, after }
      }),
    )
    expect(out.calls).toHaveLength(0)
    expect(out.result).toEqual({ fired: 0, skipped: 1 })
    expect(out.after?.nextFireAt).toBe(MAR10_0900) // still due — this is what makes recovery possible
  })

  test("after the lease expires the occurrence RUNS: the crash costs lateness, not the run", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const { s } = yield* crashedMidFire(db)
        const { launch, calls } = recorder("ses_r")
        const result = yield* CalendarScheduler.tick(db, launch, CLAIMED_AT + LEASE + 1)
        const after = yield* CalendarStore.get(db, s.id)
        const fires = yield* CalendarStore.fires(db, s.id)
        return { result, calls, after, fires }
      }),
    )
    expect(out.result).toEqual({ fired: 1, skipped: 0 })
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0]!.occurrenceMillis).toBe(MAR10_0900) // the occurrence that was lost
    expect(out.fires).toHaveLength(1) // recovered in place, never a second ledger row
    expect(out.fires[0]!.status).toBe("spawned")
    expect(out.fires[0]!.session_id).toBe("ses_r")
    expect(out.after?.nextFireAt).toBe(MAR11_0900)
  })

  test("a recovered occurrence does not run a THIRD time", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const { s } = yield* crashedMidFire(db)
        const { launch, calls } = recorder("ses_r")
        yield* CalendarScheduler.tick(db, launch, CLAIMED_AT + LEASE + 1)
        yield* CalendarScheduler.tick(db, launch, CLAIMED_AT + LEASE * 4)
        const fires = yield* CalendarStore.fires(db, s.id)
        return { calls, fires }
      }),
    )
    expect(out.calls).toHaveLength(1)
    expect(out.fires).toHaveLength(1)
  })

  test("recovery is BOUNDED: a claim nobody ever resolved stops being retried and the schedule rolls on", async () => {
    const staleBy = CalendarStore.RECOVERABLE_FOR_MINUTES * 60_000 + 60_000
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const { s } = yield* crashedMidFire(db)
        const { launch, calls } = recorder("ses_r")
        const result = yield* CalendarScheduler.tick(db, launch, CLAIMED_AT + staleBy)
        const after = yield* CalendarStore.get(db, s.id)
        const fires = yield* CalendarStore.fires(db, s.id)
        return { result, calls, after, fires }
      }),
    )
    expect(out.calls).toHaveLength(0) // a task that kills the process is not relaunched forever
    expect(out.result).toEqual({ fired: 0, skipped: 1 })
    expect(out.after!.nextFireAt!).toBeGreaterThan(CLAIMED_AT + staleBy)
    expect(out.fires[0]!.status).not.toBe("spawned") // and the ledger still does not claim it ran
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
  // A fake SessionV2 (only the ONE method makeLaunch uses) that records its calls.
  //
  // ⚠️ `create` + `prompt` collapsed into `spawn` on 2026-08-11 when the launch moved onto the
  // canonical seam. Both arrays are still recorded from the single call so every assertion below
  // reads unchanged — a launch is one operation now, but it still produces one session and one
  // queued prompt, which is what the tests are actually about.
  const fakeSessions = (created: unknown[], prompted: unknown[], started = true) =>
    ({
      spawn: (input: { text: string }) =>
        Effect.sync(() => {
          created.push(input)
          prompted.push({ sessionID: "ses_new", prompt: { text: input.text }, delivery: "queue" })
          return { id: "ses_new", started }
        }),
    }) as unknown as Pick<SessionV2.Interface, "spawn">

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
      CalendarScheduler.makeLaunch(
        fakeSessions(created, prompted),
        "/home/nancy",
      )({
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
      CalendarScheduler.makeLaunch(
        fakeSessions(created, prompted),
        "/home/nancy",
      )({
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
      CalendarScheduler.makeLaunch(
        fakeSessions(created, prompted),
        "/home/nancy",
      )({
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
      CalendarScheduler.makeLaunch(
        fakeSessions(created, prompted),
        "/home/nancy",
      )({
        schedule: sample({ location: "/srv/clients" }),
        occurrenceMillis: 1,
        firedAt: 1,
      }),
    )
    expect(created[0].location.directory).toBe("/srv/clients")
  })

  test("an unowned task is NOVA's: agent defaults to nova, model/permission still inherit", async () => {
    const created: any[] = []
    const prompted: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(
        fakeSessions(created, prompted),
        "/home/nancy",
      )({
        schedule: sample(),
        occurrenceMillis: 1,
        firedAt: 1,
      }),
    )
    expect("model" in created[0]).toBe(false)
    expect("permissionMode" in created[0]).toBe(false)
    // The owner's rule (2026-08-21): every scheduled task has somebody accountable for it, and absent
    // that is the CEO. It used to fall through to the instance default agent (`build`) - not a
    // colleague on the roster, so an unattended run landed in a chat nobody thinks of as a person's.
    expect(created[0].agent).toBe("nova")
  })

  // The folder a scheduled run happens in — the owner's rule that a colleague's folder is part of its
  // JOB, not a per-chat question. Three cases because the three answers rank, and only ordering them
  // proves it: an explicit per-task folder, else the responsible colleague's own, else instance home.
  const folderOf = (table: Record<string, string>) => (agentID: string) => Effect.succeed(table[agentID])

  test("an unowned task runs in NOVA's folder, not the instance home", async () => {
    const created: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(
        fakeSessions(created, []),
        "/home/nancy",
        folderOf({ nova: "/home/nancy/.novaclaw/scratch/nova" }),
      )({ schedule: sample(), occurrenceMillis: 1, firedAt: 1 }),
    )
    expect(created[0].location.directory).toBe("/home/nancy/.novaclaw/scratch/nova")
  })

  test("a task assigned to a colleague runs in THAT colleague's folder", async () => {
    const created: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(
        fakeSessions(created, []),
        "/home/nancy",
        folderOf({ nova: "/scratch/nova", theron: "/home/nancy/d/books" }),
      )({ schedule: sample({ agent: "theron" }), occurrenceMillis: 1, firedAt: 1 }),
    )
    expect(created[0].location.directory).toBe("/home/nancy/d/books")
  })

  test("an explicit per-task folder still outranks the colleague's own", async () => {
    const created: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(
        fakeSessions(created, []),
        "/home/nancy",
        folderOf({ theron: "/home/nancy/d/books" }),
      )({ schedule: sample({ agent: "theron", location: "/tmp/audit" }), occurrenceMillis: 1, firedAt: 1 }),
    )
    expect(created[0].location.directory).toBe("/tmp/audit")
  })

  test("an unknown colleague falls back to the instance home rather than failing the launch", async () => {
    const created: any[] = []
    await Effect.runPromise(
      CalendarScheduler.makeLaunch(
        fakeSessions(created, []),
        "/home/nancy",
        folderOf({}),
      )({
        schedule: sample({ agent: "ghost" }),
        occurrenceMillis: 1,
        firedAt: 1,
      }),
    )
    expect(created[0].location.directory).toBe("/home/nancy")
  })
})
