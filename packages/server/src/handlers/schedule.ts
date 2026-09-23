import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Database } from "@novaclaw/core/database/database"
import { AgentV2 } from "@novaclaw/core/agent"
import { ScheduleStore } from "@novaclaw/core/schedule/store"
import { Recurrence } from "@novaclaw/core/schedule/recurrence"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { ScheduleApi, handlerLayer } from "../handler-api"

const requireRunnableAgent = Effect.fn("Schedule.requireRunnableAgent")(function* (agentID: string) {
  const roster = yield* AgentV2.Service.use((agent) => agent.all())
  const selected = roster.find((agent) => String(agent.id) === agentID)
  if (!selected || !AgentV2.isColleague(selected) || AgentV2.kindOf(selected) !== "agent")
    return yield* new InvalidRequestError({ message: `No runnable agent named "${agentID}".` })
})

/**
 * The IANA zone a new schedule's wall clock should be read in — the thing a fixed offset cannot be.
 *
 * 🔴 An offset is a zone's answer at ONE instant, so a schedule pinned to one shifts by an hour twice a
 * year in every daylight-saving jurisdiction: a 09:00 report starts arriving at 08:00 and reads as a
 * scheduler bug. Naming the zone is the fix, and the instance can name its own.
 *
 * ⚠️ Only when the caller's offset AGREES with it, because the UI and the runtime need not share a
 * machine (the instance is reached by URL). Same machine ⇒ same zone ⇒ the offsets always agree, which
 * is the local-first case and the overwhelming majority. A caller elsewhere is left on its fixed offset:
 * degraded exactly as today, and never silently relabelled with a zone that is not its own.
 *
 * ⚠️ This is an INFERENCE and it is here only until the caller sends its own zone. It is unsound for the
 * one case where a remote client's offset momentarily coincides with the host's; a client-supplied zone
 * on the recurrence wins over it, and `withZone` never overwrites one.
 */
const hostZoneAgreeingWith = (tzOffsetMin: number | undefined, now: number): string | undefined => {
  let zone: string | undefined
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
  if (zone === undefined) return undefined
  if (tzOffsetMin === undefined) return zone
  return Recurrence.zoneOffsetMinutes(zone, now) === tzOffsetMin ? zone : undefined
}

const requireUsableZone = (recurrence: Recurrence.Recurrence, now: number) =>
  Effect.gen(function* () {
    const zone = Recurrence.zoneOf(recurrence)
    if (zone !== undefined && Recurrence.zoneOffsetMinutes(zone, now) === undefined)
      return yield* new InvalidRequestError({ message: `Unknown time zone: ${zone}` })
    return recurrence
  })

export const ScheduleHandler = handlerLayer(
  HttpApiBuilder.group(ScheduleApi, "server.schedule", (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle(
          "schedule.list",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            return yield* ScheduleStore.listForAgent(db, ctx.params.agentID)
          }),
        )
        .handle(
          "schedule.create",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const now = yield* Clock.currentTimeMillis
            yield* requireRunnableAgent(ctx.params.agentID)
            // The wire's recurrence is the engine's recurrence, bounds and all.
            const input: ScheduleStore.CreateInput = { ...ctx.payload, agent: ctx.params.agentID }
            const recurrence = yield* requireUsableZone(
              Recurrence.withZone(input.recurrence, hostZoneAgreeingWith(input.tzOffsetMin, now)),
              now,
            )
            return yield* ScheduleStore.create(
              db,
              {
                ...input,
                agent: ctx.params.agentID,
                recurrence,
              },
              now,
            )
          }),
        )
        .handle(
          "schedule.update",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const now = yield* Clock.currentTimeMillis
            const existing = yield* ScheduleStore.getForAgent(db, ctx.params.agentID, ctx.params.id)
            if (existing === undefined)
              return yield* new InvalidRequestError({ message: `No such schedule: ${ctx.params.id}` })

            const patch: ScheduleStore.UpdateInput = ctx.payload
            const recurrence =
              patch.recurrence === undefined
                ? undefined
                : yield* requireUsableZone(patch.recurrence, now)
            const updated = yield* ScheduleStore.updateForAgent(
              db,
              ctx.params.agentID,
              ctx.params.id,
              recurrence === undefined ? patch : { ...patch, recurrence },
              now,
            )
            // A concurrent delete between the read and write is still a client error, not a 500.
            if (updated === undefined)
              return yield* new InvalidRequestError({ message: `No such schedule: ${ctx.params.id}` })
            return updated
          }),
        )
        .handle(
          "schedule.remove",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const removed = yield* ScheduleStore.removeForAgent(db, ctx.params.agentID, ctx.params.id)
            if (!removed) return yield* new InvalidRequestError({ message: `No such schedule: ${ctx.params.id}` })
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "schedule.fires.list",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            return yield* ScheduleStore.recentFiresForAgent(db, ctx.params.agentID)
          }),
        )
        .handle(
          "schedule.confirm",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const now = yield* Clock.currentTimeMillis
            const confirmed = yield* ScheduleStore.confirmForAgent(
              db,
              ctx.params.agentID,
              ctx.params.id,
              ctx.payload.occurrenceMillis,
              now,
            )
            if (confirmed === undefined)
              return yield* new InvalidRequestError({ message: "This scheduled window is no longer open for confirmation." })
            return confirmed
          }),
        )
    }),
  ),
)
