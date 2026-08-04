import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Database } from "@novaclaw/core/database/database"
import { CalendarStore } from "@novaclaw/core/schedule/store"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Api } from "../api"

// Calendar / cron-session-creator handlers (notes/calendar-cron-plan.md). CalendarStore is the JhStore
// deps-taking shape (functions over `db`), so — unlike the service-backed messenger handler — this pulls
// `db` from Database.Service and `now` from Clock itself. `now` is injected into create so the stored
// next_fire_at is deterministic. Database.Service resolves to the SAME instance the poll loop uses, so a
// schedule created here is immediately visible to CalendarScheduler's tick.
export const CalendarHandler = HttpApiBuilder.group(Api, "server.calendar", (handlers) =>
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
          // The endpoint schema validated shape; narrow weekdays (number[] -> Weekday[]) at the boundary.
          return yield* CalendarStore.create(db, ctx.payload as unknown as CalendarStore.CreateInput, now)
        }),
      )
      .handle(
        "calendar.schedule.update",
        Effect.fn(function* (ctx) {
          const { db } = yield* Database.Service
          const now = yield* Clock.currentTimeMillis
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
)
