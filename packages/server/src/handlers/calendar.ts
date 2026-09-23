import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Database } from "@novaclaw/core/database/database"
import { AgentV2 } from "@novaclaw/core/agent"
import { CalendarStore } from "@novaclaw/core/schedule/store"
import { Recurrence } from "@novaclaw/core/schedule/recurrence"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { CalendarApi, handlerLayer } from "../handler-api"

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

export const CalendarHandler = handlerLayer(
  HttpApiBuilder.group(CalendarApi, "server.calendar", (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle(
          "calendar.schedule.list",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            return yield* CalendarStore.listForAgent(db, ctx.params.agentID)
          }),
        )
        .handle(
          "calendar.schedule.create",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const now = yield* Clock.currentTimeMillis
            yield* requireRunnableAgent(ctx.params.agentID)
            // The wire's recurrence is the engine's recurrence, bounds and all.
            const input: CalendarStore.CreateInput = { ...ctx.payload, agent: ctx.params.agentID }
            return yield* CalendarStore.create(
              db,
              {
                ...input,
                agent: ctx.params.agentID,
                recurrence: Recurrence.withZone(input.recurrence, hostZoneAgreeingWith(input.tzOffsetMin, now)),
              },
              now,
            )
          }),
        )
        .handle(
          "calendar.schedule.update",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const now = yield* Clock.currentTimeMillis
            const existing = yield* CalendarStore.getForAgent(db, ctx.params.agentID, ctx.params.id)
            if (existing === undefined)
              return yield* new InvalidRequestError({ message: `No such schedule: ${ctx.params.id}` })

            const patch: CalendarStore.UpdateInput = ctx.payload
            // A re-sent recurrence keeps the zone the schedule already had — the wire cannot carry one
            // yet, so reading it back off the stored rule is what stops a save from downgrading a
            // zone-correct schedule to a fixed offset.
            const updated = yield* CalendarStore.updateForAgent(
              db,
              ctx.params.agentID,
              ctx.params.id,
              patch.recurrence === undefined
                ? patch
                : {
                    ...patch,
                    recurrence: Recurrence.withZone(
                      patch.recurrence,
                      Recurrence.zoneOf(existing.recurrence) ?? hostZoneAgreeingWith(patch.tzOffsetMin, now),
                    ),
                  },
              now,
            )
            // A concurrent delete between the read and write is still a client error, not a 500.
            if (updated === undefined)
              return yield* new InvalidRequestError({ message: `No such schedule: ${ctx.params.id}` })
            return updated
          }),
        )
        .handle(
          "calendar.schedule.remove",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const removed = yield* CalendarStore.removeForAgent(db, ctx.params.agentID, ctx.params.id)
            if (!removed) return yield* new InvalidRequestError({ message: `No such schedule: ${ctx.params.id}` })
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "calendar.fires.list",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            return yield* CalendarStore.recentFiresForAgent(db, ctx.params.agentID)
          }),
        )
    }),
  ),
)
