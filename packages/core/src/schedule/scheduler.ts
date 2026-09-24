export * as ScheduleScheduler from "./scheduler"

import { eq, isNull, and } from "drizzle-orm"
import { Clock, Context, Duration, Effect, Layer, Schedule } from "effect"
import { AgentV2 } from "../agent"
import { AgentConfigStore } from "../agent-config-store"
import { AgentWorkspace } from "../agent/workspace"
import { ColleagueStall } from "../session/colleague-stall"
import { Database } from "../database/database"
import { makeGlobalNode, tags } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { EventV2 } from "../event"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { NudgeService } from "../nudge-service"
import type { EpochMillis } from "./recurrence"
import { ScheduleStore } from "./store"
import { Log } from "@novaclaw/schema/log"

type Db = Database.Interface["db"]

export interface Notice {
  readonly kind: "heartbeat" | "escalation"
  readonly schedule: ScheduleStore.Schedule
  readonly fire: ScheduleStore.Fire
  readonly agent: string
  readonly heartbeatAt?: number
}

export type Deliver = (notice: Notice) => Effect.Effect<void, unknown>

export interface TickResult {
  readonly opened: number
  readonly heartbeats: number
  readonly failed: number
  readonly escalated: number
}

export const MAX_WINDOWS_OPENED_PER_TICK = 64

export const heartbeatText = (schedule: ScheduleStore.Schedule, fire: ScheduleStore.Fire): string =>
  `Scheduled work is active: ${schedule.title || "Scheduled task"}.\n` +
  `Task: ${schedule.prompt}\n` +
  `This window ends at ${new Date(fire.windowEndAt).toISOString()}. ` +
  `When finished, call the schedule tool with op: confirm, scheduleId: ${schedule.id}, ` +
  `occurrenceMillis: ${fire.occurrenceMillis}. You will receive another reminder every ` +
  `${schedule.heartbeatMinutes} minutes until you confirm or the window ends. ` +
  `Will recur; to disable call schedule({"op":"disable","scheduleId":${JSON.stringify(schedule.id)}}).`

export const escalationText = (schedule: ScheduleStore.Schedule, fire: ScheduleStore.Fire): string =>
  `Scheduled work was not confirmed before its window ended. Officer: ${schedule.agent}. ` +
  `Task: ${schedule.title || schedule.prompt}. ` +
  `Window: ${new Date(fire.occurrenceMillis).toISOString()} to ${new Date(fire.windowEndAt).toISOString()}. ` +
  (schedule.agent === AgentV2.NOVA_ID
    ? `Report this missed work to the owner in this chat and decide how to recover.`
    : `Please review the failure and decide how to recover.`)

export const tick = (db: Db, deliver: Deliver, superiorOf: (agent: string) => Effect.Effect<string | undefined>, now: EpochMillis): Effect.Effect<TickResult> =>
  Effect.gen(function* () {
    yield* ScheduleStore.pruneFires(db, now)
    let opened = 0
    let heartbeats = 0
    let failed = 0
    let escalated = 0
    while (opened < MAX_WINDOWS_OPENED_PER_TICK) {
      const due = yield* ScheduleStore.due(db, now)
      if (due.length === 0) break
      for (const schedule of due) {
        if (opened >= MAX_WINDOWS_OPENED_PER_TICK) break
        if (schedule.nextFireAt === null) continue
        const fire = yield* ScheduleStore.openWindow(db, schedule, schedule.nextFireAt, now)
        opened++
        if (fire.outcome === "failed") failed++
        yield* ScheduleStore.advance(db, schedule.id)
      }
    }
    for (const { schedule, fire } of yield* ScheduleStore.activeWindows(db, now)) {
      if (now >= fire.windowEndAt) {
        if (yield* ScheduleStore.expireWindow(db, fire, now)) failed++
        continue
      }
      if (fire.nextHeartbeatAt === null || now < fire.nextHeartbeatAt) continue
      const delivered = yield* deliver({ kind: "heartbeat", schedule, fire, agent: schedule.agent, heartbeatAt: fire.nextHeartbeatAt })
        .pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))
      if (!delivered) continue
      if (yield* ScheduleStore.claimHeartbeat(db, fire, schedule.heartbeatMinutes, now)) heartbeats++
    }
    for (const { schedule, fire } of yield* ScheduleStore.failedUnescalated(db)) {
      const configuredSuperior = yield* superiorOf(schedule.agent)
      const superior = configuredSuperior === undefined || configuredSuperior === "human" || configuredSuperior === "owner"
        ? AgentV2.NOVA_ID : configuredSuperior
      const delivered = yield* deliver({ kind: "escalation", schedule, fire, agent: superior })
        .pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))
      if (!delivered) continue
      yield* ScheduleStore.markEscalated(db, fire, now)
      escalated++
    }
    return { opened, heartbeats, failed, escalated }
  })

export interface Interface { readonly running: true }
export class Service extends Context.Service<Service, Interface>()("@novaclaw/ScheduleScheduler") {}

export const TICK_INTERVAL_SECONDS = 30

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const { db } = yield* Database.Service
  const sessions = yield* SessionV2.Service
  const agents = yield* AgentConfigStore.Service
  const events = yield* EventV2.Service
  const nudges = yield* NudgeService.Service
  const superiorOf = Effect.fn("ScheduleScheduler.superiorOf")(function* (agent: string) {
    if (agent === AgentV2.NOVA_ID) return undefined
    const roster = yield* agents.agents()
    const selected = AgentConfigStore.fold(roster[agent] ?? [])?.superior ?? AgentV2.NOVA_ID
    if (selected === AgentV2.NOVA_ID) return selected
    const seen = new Set([agent])
    let cursor = selected
    while (cursor !== AgentV2.NOVA_ID) {
      if (seen.has(cursor)) return AgentV2.NOVA_ID
      seen.add(cursor)
      const current = AgentConfigStore.fold(roster[cursor] ?? [])
      if (!current || current.kind === "chat" || current.kind === "human") return AgentV2.NOVA_ID
      cursor = current.superior ?? AgentV2.NOVA_ID
    }
    return selected
  })
  const deliver: Deliver = Effect.fn("ScheduleScheduler.deliver")(function* (notice) {
    const agent = AgentV2.ID.make(notice.agent)
    const live = yield* db.select({ id: SessionTable.id, createdAt: SessionTable.time_created }).from(SessionTable).where(and(
      eq(SessionTable.agent, agent), isNull(SessionTable.parent_id), isNull(SessionTable.time_archived),
    )).get().pipe(Effect.orDie)
    const configured = AgentConfigStore.fold((yield* agents.agents())[agent] ?? [])
    if (!live) yield* sessions.create({
      agent,
      location: { directory: AbsolutePath.make(AgentWorkspace.folderFor({
        agentID: agent, directory: configured?.directory, shortChat: configured?.shortChat,
      })) },
    })
    const chat = live ?? (yield* db.select({ id: SessionTable.id, createdAt: SessionTable.time_created })
      .from(SessionTable).where(and(eq(SessionTable.agent, agent), isNull(SessionTable.parent_id), isNull(SessionTable.time_archived)))
      .get().pipe(Effect.orDie))
    if (!chat) return yield* Effect.die(`No live chat for scheduled officer ${agent}`)
    const sessionID = chat.id
    const occurrence = notice.kind === "heartbeat"
      ? `heartbeat:${notice.fire.occurrenceMillis}:${notice.heartbeatAt}`
      : `escalation:${notice.fire.occurrenceMillis}`
    const text = notice.kind === "heartbeat"
      ? heartbeatText(notice.schedule, notice.fire)
      : escalationText(notice.schedule, notice.fire)
    yield* nudges.deliverScheduled({
      sessionID,
      sessionEpoch: chat.createdAt,
      scheduleID: notice.kind === "heartbeat" ? notice.schedule.id : `${notice.schedule.id}:escalation`,
      occurrence,
      text,
      admittedAt: notice.heartbeatAt ?? notice.fire.failedAt ?? notice.fire.windowEndAt,
      admit: (messageID, promptedText) => sessions.prompt({
        id: messageID,
        sessionID: SessionSchema.ID.make(sessionID),
        prompt: { text: promptedText },
        delivery: "steer",
        resume: true,
      }).pipe(Effect.map((admitted) => admitted.sessionID)),
    })
  })
  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* tick(db, deliver, superiorOf, now)
    yield* ColleagueStall.sweep(db, events, now)
  }).pipe(
    Effect.catchCause((cause) => Log.event("instance.schedule.tick.failed", { "instance.cause": Log.fault(cause) })),
    Effect.repeat(Schedule.spaced(Duration.seconds(TICK_INTERVAL_SECONDS))),
    Effect.delay(Duration.seconds(5)),
    Effect.forkScoped,
  )
  return Service.of({ running: true })
}))

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionV2.node, AgentConfigStore.node, EventV2.node, NudgeService.node],
})

export const sharedServiceNode = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    LayerNode.external(Database.Service, tags.values.global),
    LayerNode.external(SessionV2.Service, tags.values.global),
    LayerNode.external(AgentConfigStore.Service, tags.values.global),
    LayerNode.external(EventV2.Service, tags.values.global),
    LayerNode.external(NudgeService.Service, tags.values.global),
  ],
})

export const capabilityNode = LayerNode.capability(node, { name: "schedule-scheduler", service: Service })
export const CapabilityService = capabilityNode.service
export const sharedCapabilityNode = LayerNode.capability(sharedServiceNode, { name: "schedule-scheduler", service: Service })
