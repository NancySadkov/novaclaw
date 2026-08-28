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

// Calendar / cron-session-creator handlers (notes/calendar-cron-plan.md). CalendarStore is the JhStore
// deps-taking shape (functions over `db`), so — unlike the service-backed messenger handler — this pulls
// `db` from Database.Service and `now` from Clock itself. `now` is injected into create so the stored
// next_fire_at is deterministic. Database.Service resolves to the SAME instance the poll loop uses, so a
// schedule created here is immediately visible to CalendarScheduler's tick.

/**
 * 🔴 NC-REL-027 — refuse execution settings that cannot run, WHERE THE USER CAN STILL FIX THEM.
 *
 * `agent` and `model` were free-text strings no write boundary resolved: a typo persisted happily
 * and failed hours later inside a detached session, on work nobody was present to retry. Scheduled
 * work is explicitly unattended, which is exactly why late validation is expensive here.
 *
 * ⚠️ **Both the roster and the catalog are LOCATION services** (`location-services.ts` lists
 * `AgentV2.node` and `Catalog.node`), and `calendar.*` carries no location middleware. Two wrong
 * versions of this preceded the right one, both green under `tsgo` and both 500 on every request:
 * resolving `AgentV2.Service` from this global handler, then falling back to `Location.Service`,
 * which is not ambient here either. `session.ts:624` had already recorded the rule — a global layer
 * consulting a location node "crosses a layer boundary the graph refuses to build".
 *
 * ⚠️ So the check runs in the ONE location a schedule actually pins: its own `location` field. It is
 * not a stand-in for the fire location — the scheduler resolves `schedule.location ?? colleague's
 * folder ?? home` at FIRE time, on purpose, so a colleague reassigned after the save fires in its new
 * folder. Validating against a folder chosen here would re-introduce exactly the save-time snapshot
 * that comment exists to prevent, and would refuse settings that are perfectly valid where they run.
 *
 * ⚠️ **Known narrowness, stated rather than hidden:** a schedule that names no location is not
 * checked at all. Its fire location is deliberately late-bound, and a project can contribute both
 * agents and models (`novaclaw.json`), so no location this handler could pick would give the same
 * answer. Widening it means giving `CalendarGroup` location middleware the way `makeSessionGroups`
 * and `makePermissionGroup` already take it — a protocol change, filed rather than smuggled in here.
 *
 * ⚠️ A lookup that FAILS does not refuse the write. The roster and catalog are consulted to help the
 * user; an instance mid-reload must not turn "I cannot check" into "your schedule is invalid",
 * trading a real save for a transient fault.
 */
const refuseUnrunnable = Effect.fn("Calendar.refuseUnrunnable")(function* (
  settings: { readonly agent?: string | null; readonly model?: string | null },
  directory: string | null | undefined,
) {
  if (!directory) return
  if (!settings.agent && !settings.model) return
  const located = (yield* LocationServiceMap.Service).get(
    Location.Ref.make({ directory: AbsolutePath.make(directory) }),
  )
  const known = yield* Effect.gen(function* () {
    const roster = yield* AgentV2.Service.use((agent) => agent.all())
    const models = yield* Catalog.Service.use((catalog) => catalog.model.all())
    return {
      agents: new Set(roster.map((item) => String(item.id))),
      models: new Set(models.map((model) => `${model.providerID}/${model.id}`)),
    }
  }).pipe(
    Effect.provide(located),
    Effect.catchCause((cause) =>
      // ⚠️ LOGGED, not merely swallowed. The first live run of this check accepted a bogus agent and
      // said nothing, because the failure and the "nothing wrong" answer were the same silence. A
      // check that cannot report its own blindness is indistinguishable from one that passed.
      Log.event("instance.calendar.settings.unchecked", { "instance.cause": Log.fault(cause) }).pipe(Effect.as(undefined)),
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
            // ⚠️ The UPDATE too, not only create. A schedule that was valid when written can be
            // repointed at a retired colleague in one PATCH, and the fire that then fails is just as
            // unattended as the first one.
            yield* refuseUnrunnable(ctx.payload, ctx.payload.location ?? undefined)
            const updated = yield* CalendarStore.update(
              db,
              ctx.params.id,
              ctx.payload as unknown as CalendarStore.UpdateInput,
              now,
            )
            // A missing schedule is a client error, not a 500 — the row may have been deleted meanwhile.
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
