import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Database } from "@novaclaw/core/database/database"
import { Log } from "@novaclaw/schema/log"
import { AgentV2 } from "@novaclaw/core/agent"
import { Catalog } from "@novaclaw/core/catalog"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { AbsolutePath } from "@novaclaw/core/schema"
import { CalendarStore } from "@novaclaw/core/schedule/store"
import { ScheduleExecutionSettings } from "@novaclaw/core/schedule/execution-settings"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { CalendarApi, handlerLayer } from "../handler-api"

// Calendar / cron-session-creator handlers. CalendarStore is the JhStore
// deps-taking shape (functions over `db`), so — unlike the service-backed messenger handler — this pulls
// `db` from Database.Service and `now` from Clock itself. `now` is injected into create so the stored
// next_fire_at is deterministic. Database.Service resolves to the SAME instance the poll loop uses, so a
// schedule created here is immediately visible to CalendarScheduler's tick.

/**
 * Refuse named execution settings that cannot run, while the user can still repair them.
 *
 * The write endpoints carry location middleware, so an unpinned schedule is checked against the
 * request's ambient roster and catalog. An explicit schedule folder is authoritative: its location
 * graph replaces the ambient one for this lookup. That pin is not a snapshot of an unpinned
 * schedule's eventual fire location; the scheduler still resolves colleague folder/home at fire
 * time on purpose.
 *
 * A lookup failure does not refuse the write. The roster and catalog are advisory validation here;
 * an instance mid-reload must not turn "I cannot check" into "your schedule is invalid". The fault
 * is logged so an unchecked save is not indistinguishable from a successful check.
 */
const refuseUnrunnable = Effect.fn("Calendar.refuseUnrunnable")(function* (
  settings: { readonly agent?: string | null; readonly model?: string | null },
  pinnedDirectory: string | null | undefined,
) {
  if (!settings.agent && !settings.model) return

  const readKnown = Effect.gen(function* () {
    const roster = yield* AgentV2.Service.use((agent) => agent.all())
    const models = yield* Catalog.Service.use((catalog) => catalog.model.all())
    return {
      agents: new Set(roster.map((item) => String(item.id))),
      models: new Set(models.map((model) => `${model.providerID}/${model.id}`)),
    }
  })
  const check = pinnedDirectory
    ? readKnown.pipe(
        Effect.provide(
          (yield* LocationServiceMap.Service).get(Location.Ref.make({ directory: AbsolutePath.make(pinnedDirectory) })),
        ),
      )
    : readKnown
  const known = yield* check.pipe(
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
            // No pin means the request's ambient location. A pin replaces it inside
            // `refuseUnrunnable`; the stored value itself remains the scheduler's authority.
            yield* refuseUnrunnable(ctx.payload, ctx.payload.location)
            // The endpoint schema validated shape; narrow weekdays (number[] -> Weekday[]) at the boundary.
            return yield* CalendarStore.create(db, ctx.payload as unknown as CalendarStore.CreateInput, now)
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

            // Validate only when the resulting execution placement/settings can change. A pause or
            // title edit must remain possible even if a colleague was retired since the schedule was
            // written. When validation is needed, omitted fields inherit the existing row: notably,
            // an existing pinned folder stays authoritative, while `location: null` deliberately
            // clears the pin and switches the check to the request's ambient location.
            if (
              ctx.payload.agent !== undefined ||
              ctx.payload.model !== undefined ||
              ctx.payload.location !== undefined
            ) {
              yield* refuseUnrunnable(
                {
                  agent: ctx.payload.agent === undefined ? existing.agent : ctx.payload.agent,
                  model: ctx.payload.model === undefined ? existing.model : ctx.payload.model,
                },
                ctx.payload.location === undefined ? existing.location : ctx.payload.location,
              )
            }
            const updated = yield* CalendarStore.update(
              db,
              ctx.params.id,
              ctx.payload as unknown as CalendarStore.UpdateInput,
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
