import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Database } from "@novaclaw/core/database/database"
import { Log } from "@novaclaw/schema/log"
import { AgentV2 } from "@novaclaw/core/agent"
import { CalendarStore } from "@novaclaw/core/schedule/store"
import { Recurrence } from "@novaclaw/core/schedule/recurrence"
import { ScheduleExecutionSettings } from "@novaclaw/core/schedule/execution-settings"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { CalendarApi, handlerLayer } from "../handler-api"

// Calendar / cron-session-creator handlers. CalendarStore is the JhStore
// deps-taking shape (functions over `db`), so — unlike the service-backed messenger handler — this pulls
// `db` from Database.Service and `now` from Clock itself. `now` is injected into create so the stored
// next_fire_at is deterministic. Database.Service resolves to the SAME instance the poll loop uses, so a
// schedule created here is immediately visible to CalendarScheduler's tick.

/**
 * Refuse a responsible agent that cannot run, while the user can still repair it.
 *
 * The write endpoints carry location middleware, so the schedule is checked against the request's
 * ambient roster.
 *
 * A lookup failure does not refuse the write. The roster is advisory validation here; an instance
 * mid-reload must not turn "I cannot check" into "your schedule is invalid". The fault is logged so
 * an unchecked save is not indistinguishable from a successful check.
 */
const refuseUnrunnable = Effect.fn("Calendar.refuseUnrunnable")(function* (settings: {
  readonly agent?: string | null
}) {
  if (!settings.agent) return

  const known = yield* AgentV2.Service.use((agent) => agent.all()).pipe(
    Effect.map((roster) => ({ agents: new Set(roster.map((item) => String(item.id))) })),
    Effect.catchCause((cause) =>
      Log.event("instance.calendar.settings.unchecked", { "instance.cause": Log.fault(cause) }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
  if (known === undefined) return
  const refusal = ScheduleExecutionSettings.refusal(settings, known)
  if (refusal) return yield* new InvalidRequestError({ message: refusal })
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
          Effect.fn(function* () {
            const { db } = yield* Database.Service
            return yield* CalendarStore.list(db)
          }),
        )
        .handle(
          "calendar.schedule.create",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const now = yield* Clock.currentTimeMillis
            // The request's ambient location is the check's authority.
            yield* refuseUnrunnable(ctx.payload)
            // No narrowing left to do: the wire's recurrence IS the engine's, bounds and all.
            const input: CalendarStore.CreateInput = ctx.payload
            return yield* CalendarStore.create(
              db,
              {
                ...input,
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
            const existing = yield* CalendarStore.get(db, ctx.params.id)
            if (existing === undefined)
              return yield* new InvalidRequestError({ message: `No such schedule: ${ctx.params.id}` })

            // Validate only when the responsible agent can change. A pause or title edit must remain
            // possible even if a colleague was retired since the schedule was written.
            if (ctx.payload.agent !== undefined) {
              yield* refuseUnrunnable({ agent: ctx.payload.agent })
            }
            const patch: CalendarStore.UpdateInput = ctx.payload
            // A re-sent recurrence keeps the zone the schedule already had — the wire cannot carry one
            // yet, so reading it back off the stored rule is what stops a save from downgrading a
            // zone-correct schedule to a fixed offset.
            const updated = yield* CalendarStore.update(
              db,
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
            yield* CalendarStore.remove(db, ctx.params.id)
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "calendar.fires.list",
          Effect.fn(function* () {
            const { db } = yield* Database.Service
            return yield* CalendarStore.recentFires(db)
          }),
        )
    }),
  ),
)
