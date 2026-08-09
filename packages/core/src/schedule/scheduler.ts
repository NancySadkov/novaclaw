export * as CalendarScheduler from "./scheduler"

// Calendar / cron-session creator (P2): the ticker's decision logic, isolated from boot wiring and the real
// session launch (P3) so it is deterministically unit-testable. `tick` runs one poll cycle: fire every DUE
// schedule exactly once (idempotent via the store's fire ledger), then roll it forward. Catch-up policy is
// fire-once — a schedule missed while the instance was down fires its due occurrence once and jumps to the
// next FUTURE occurrence (advance computes strictly after `now`); missed intermediate occurrences are not
// replayed (no thundering herd). A launch failure is isolated (never wedges the loop), recorded as `error`,
// and the schedule still advances.

import { Clock, Context, Duration, Effect, Layer, Schedule } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeGlobalNode, tags } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { Global } from "../global"
import { ModelV2 } from "../model"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import type { EpochMillis } from "./recurrence"
import { CalendarStore } from "./store"
import { Log } from "@novaclaw/schema/log"

export interface LaunchInput {
  readonly schedule: CalendarStore.Schedule
  readonly occurrenceMillis: number
  readonly firedAt: number
}

/**
 * Create + start the session for a fired schedule. Returns the new session id, or null on no-session.
 * May fail — `tick` absorbs every cause so a bad launch never wedges the poll loop.
 */
export type Launch = (input: LaunchInput) => Effect.Effect<string | null, unknown>

export interface TickResult {
  /** Occurrences that launched a session this cycle. */
  readonly fired: number
  /** Due occurrences that were already claimed by a prior cycle, or whose launch produced no session. */
  readonly skipped: number
}

type Db = Database.Interface["db"]

/** One poll cycle. `now` is injected (the boot loop passes `yield* Clock.currentTimeMillis`). */
export const tick = (db: Db, launch: Launch, now: EpochMillis): Effect.Effect<TickResult> =>
  Effect.gen(function* () {
    const due = yield* CalendarStore.due(db, now)
    let fired = 0
    let skipped = 0
    for (const schedule of due) {
      const occurrence = schedule.nextFireAt
      if (occurrence === null) continue // due() already excludes nulls; defensive.

      // Claim the occurrence BEFORE doing any work — the idempotency guard against overlapping
      // ticks / a restart mid-fire. A losing claim means another cycle already handled it.
      const claimed = yield* CalendarStore.recordFire(db, {
        scheduleId: schedule.id,
        occurrenceMillis: occurrence,
        firedAt: now,
        status: "spawned",
      })
      if (claimed) {
        const sessionId = yield* launch({ schedule, occurrenceMillis: occurrence, firedAt: now }).pipe(
          // A bad launch must never kill the poll loop — record it and move on.
          Effect.catchCause(() => Effect.succeed(null)),
        )
        yield* CalendarStore.setFireOutcome(db, {
          scheduleId: schedule.id,
          occurrenceMillis: occurrence,
          sessionId,
          status: sessionId ? "spawned" : "error",
        })
        if (sessionId !== null) fired++
        else skipped++
      } else {
        skipped++
      }

      // Roll forward regardless so this occurrence is never re-returned by due().
      yield* CalendarStore.advance(db, schedule.id, now)
    }
    return { fired, skipped }
  })

/**
 * The real launch seam (P3): create a goal-oriented session at the schedule's location (its own directory,
 * else the instance home) and QUEUE its prompt. Typed to only the two SessionV2 methods it uses, so it is
 * unit-testable with a fake. Returns the new session id. `metadata` stamps the schedule + occurrence so a
 * fired run is traceable back to its schedule.
 */
export const makeLaunch =
  (sessions: Pick<SessionV2.Interface, "create" | "prompt">, homeDir: string): Launch =>
  (input) =>
    Effect.gen(function* () {
      const { schedule } = input
      const directory = schedule.location ?? homeDir
      // Per-schedule overrides; absent = inherit the instance default agent/model. Model string is
      // "providerID/modelID" (split so the modelID may itself contain "/").
      let model: ModelV2.Ref | undefined
      if (schedule.model) {
        const { providerID, modelID } = ModelV2.parse(schedule.model)
        model = ModelV2.Ref.make({ id: modelID, providerID })
      }
      const agent = schedule.agent ? AgentV2.ID.make(schedule.agent) : undefined
      const session = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory) },
        type: "goal-oriented",
        title: schedule.title || "Scheduled run",
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
        // Per-schedule permission posture; absent = inherit the default. A scheduled run is unattended, so
        // "ask" would stall waiting for an approval nobody's there to give — the UI defaults to "bypass"
        // (act within its work folder; external-directory writes still gate).
        ...(schedule.permissionMode
          ? { permissionMode: schedule.permissionMode as "plan" | "ask" | "surgical" | "bypass" | "yolo" }
          : {}),
        metadata: { calendarScheduleID: schedule.id, occurrenceMillis: input.occurrenceMillis },
      })
      yield* sessions.prompt({
        sessionID: session.id,
        prompt: { text: schedule.prompt },
        delivery: "queue",
      })
      return session.id
    })

/** Seconds between poll ticks. Sub-minute so a schedule due "now" fires promptly; the scan is index-cheap. */
export const TICK_INTERVAL_SECONDS = 30

export interface Interface {
  readonly running: true
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/CalendarScheduler") {}

/**
 * The background poll loop (P3). Leaves Database + SessionV2 + Global as UNSATISFIED requirements so the
 * serve binds them to the SHARED singletons (mirror the messenger gateway). The production capability uses
 * `sharedServiceNode` before the SessionV2 provide; `node` exists for closed graphs/tests. Never put that closed
 * node in the production app group — compiling a second SessionV2 would launch into the wrong runtime.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const global = yield* Global.Service
    const launch = makeLaunch(sessions, global.home)
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* tick(db, launch, now)
    }).pipe(
      Effect.catchCause((cause) => Log.event("instance.scheduler.tick.failed", { "instance.cause": Log.fault(cause) })),
      Effect.repeat(Schedule.spaced(Duration.seconds(TICK_INTERVAL_SECONDS))),
      Effect.delay(Duration.seconds(5)),
      Effect.forkScoped,
    )
    return Service.of({ running: true })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionV2.node, Global.node],
})

export const sharedServiceNode = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    LayerNode.external(Database.Service, tags.values.global),
    LayerNode.external(SessionV2.Service, tags.values.global),
    LayerNode.external(Global.Service, tags.values.global),
  ],
})

export const capabilityNode = LayerNode.capability(node, { name: "calendar-scheduler", service: Service })
export const CapabilityService = capabilityNode.service
export const sharedCapabilityNode = LayerNode.capability(sharedServiceNode, {
  name: "calendar-scheduler",
  service: Service,
})
