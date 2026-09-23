import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

// Scheduled agent work uses structured recurrence rules and belongs to one agent.

/**
 * ─── THE RUNNABLE DOMAIN ─────────────────────────────────────────────────────────────────────────
 *
 * 🔴 **The wire's recurrence is the ENGINE's recurrence, and these bounds are why.** The scheduler
 * (`core/schedule/recurrence.ts`) reads a wall clock: `Weekday` is `0..6`, an hour is `0..23`, a
 * minute `0..59`, a day-of-month `1..31`, a month `1..12`. Anything outside that is not a schedule
 * the engine runs slightly wrong — it is a schedule that **never fires**, stored and answered `201`.
 * `nextFire` scans 800 days, `matchesDay` is never true, `next_fire_at` is written `null`, and the
 * row sits in the agent's Schedule tab reading `enabled: true` forever. `weekdays: [7]`, `weekdays: []` and
 * `{kind:"monthly", day:0}` all land there, and so does any JSON non-finite stand-in (`"NaN"`,
 * `"Infinity"`), because every comparison against those is false.
 *
 * ⚠️ `{"hour": 25}` is the one that is worse than never firing: `Date.UTC(y, m, d, 25, 0)` rolls
 * into the NEXT day at 01:00, so the schedule fires — at the wrong hour, on the wrong day, and
 * nothing anywhere says so.
 *
 * A caller told "scheduled" for something that can never happen is a failed mutation reporting
 * success, so the refusal belongs here, at the wire, naming the field. Keeping the bounds ON the
 * schema (rather than as a boundary cast in the handler) is also what makes the two types the same
 * type: a cast is exactly what stops the compiler from noticing they are not.
 */
const Hour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }))
const Minute = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 }))
const MonthDay = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }))
const Month = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }))
/** 0 = Sunday … 6 = Saturday, matching `Date#getUTCDay` — the engine's `Weekday`. */
const Weekday = Schema.Literals([0, 1, 2, 3, 4, 5, 6])
/**
 * Minutes east of UTC. Deliberately wider than any real zone (±14:00): the job of this bound is to
 * exclude the values the arithmetic cannot survive, not to police the caller's geography.
 */
const TzOffsetMin = Schema.Int.check(Schema.isBetween({ minimum: -1440, maximum: 1440 }))
const DurationMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))
const HeartbeatMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))

const HM = Schema.Struct({ hour: Hour, minute: Minute })
const Zone = Schema.optional(Schema.String)

/**
 * Exported so the guard has a NAME to hold. `server/src/handlers/schedule-recurrence-domain.test.ts`
 * decodes fixtures through these and hands the result straight to `Recurrence.nextFire` with no cast
 * — which is the assertion: every recurrence this wire accepts is one the engine can run.
 */
export const Recurrence = Schema.Union([
  // A non-finite instant is never `> after`, so it is the never-fires case wearing a number.
  Schema.Struct({ kind: Schema.Literals(["once"]), at: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literals(["daily"]), time: HM, zone: Zone }),
  // An empty list matches no calendar day — the same defect spelled entirely with valid weekdays.
  Schema.Struct({
    kind: Schema.Literals(["weekly"]),
    time: HM,
    weekdays: Schema.Array(Weekday).check(Schema.isMinLength(1)),
    zone: Zone,
  }),
  Schema.Struct({ kind: Schema.Literals(["monthly"]), time: HM, day: MonthDay, zone: Zone }),
  Schema.Struct({ kind: Schema.Literals(["yearly"]), time: HM, month: Month, day: MonthDay, zone: Zone }),
]).annotate({ identifier: "Schedule.Recurrence" })

export const Schedule = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  recurrence: Recurrence,
  tzOffsetMin: TzOffsetMin,
  prompt: Schema.String,
  agent: Schema.String,
  durationMinutes: DurationMinutes,
  heartbeatMinutes: HeartbeatMinutes,
  escalateOnFailure: Schema.Boolean,
  enabled: Schema.Boolean,
  nextFireAt: Schema.NullOr(Schema.Finite),
  lastFiredAt: Schema.NullOr(Schema.Finite),
  timeCreated: Schema.Finite,
  timeUpdated: Schema.Finite,
}).annotate({ identifier: "Schedule.Schedule" })

const Fire = Schema.Struct({
  id: Schema.String,
  scheduleId: Schema.String,
  occurrenceMillis: Schema.Finite,
  firedAt: Schema.Finite,
  outcome: Schema.Literals(["pending", "confirmed", "failed"]),
  windowEndAt: Schema.Finite,
  lastHeartbeatAt: Schema.NullOr(Schema.Finite),
  confirmedAt: Schema.NullOr(Schema.Finite),
  failedAt: Schema.NullOr(Schema.Finite),
  escalatedAt: Schema.NullOr(Schema.Finite),
  nextHeartbeatAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "Schedule.Fire" })

export const CreateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  recurrence: Recurrence,
  tzOffsetMin: Schema.optional(TzOffsetMin),
  prompt: Schema.String,
  durationMinutes: Schema.optional(DurationMinutes),
  heartbeatMinutes: Schema.optional(HeartbeatMinutes),
  escalateOnFailure: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Schedule.CreateInput" })

// Every field optional — the common case is a one-field pause/resume (`enabled`). An omitted field is
// left untouched; the store recomputes next_fire_at from whatever the merged recurrence/tz/enabled are.
const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  recurrence: Schema.optional(Recurrence),
  tzOffsetMin: Schema.optional(TzOffsetMin),
  prompt: Schema.optional(Schema.String),
  durationMinutes: Schema.optional(DurationMinutes),
  heartbeatMinutes: Schema.optional(HeartbeatMinutes),
  escalateOnFailure: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Schedule.UpdateInput" })

const ConfirmInput = Schema.Struct({ occurrenceMillis: Schema.Finite }).annotate({ identifier: "Schedule.ConfirmInput" })

export const makeScheduleGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApiGroup.make("server.schedule")
    .add(
      HttpApiEndpoint.get("schedule.list", "/api/agent/:agentID/schedule", {
        params: { agentID: Schema.String },
        success: Schema.Array(Schedule),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.list",
          summary: "List an agent's schedules",
          description: "Retrieve the agent's scheduled tasks with their next-fire times.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("schedule.create", "/api/agent/:agentID/schedule", {
        params: { agentID: Schema.String },
        payload: CreateInput,
        success: Schedule,
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.schedule.create",
            summary: "Create an agent schedule",
            description:
              "Schedule a repeatable or one-shot work window. The recurrence is structured (once/daily/weekly/monthly/yearly); the agent receives a task and periodic reminders until it confirms completion.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("schedule.update", "/api/agent/:agentID/schedule/:id", {
        params: { agentID: Schema.String, id: Schema.String },
        payload: UpdateInput,
        success: Schedule,
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.schedule.update",
            summary: "Update an agent schedule",
            description:
              "Patch an agent's scheduled task — pause/resume it (enabled), or change its title, prompt, or recurrence. The next-fire time is recomputed; a disabled schedule has none.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("schedule.remove", "/api/agent/:agentID/schedule/:id", {
        params: { agentID: Schema.String, id: Schema.String },
        success: HttpApiSchema.NoContent,
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.remove",
          summary: "Remove an agent schedule",
          description: "Delete an agent's scheduled task by id.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("schedule.fires.list", "/api/agent/:agentID/schedule/fires", {
        params: { agentID: Schema.String },
        success: Schema.Array(Fire),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.fires.list",
          summary: "List recent schedule fires",
          description: "Recent scheduled runs for one agent, newest first.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("schedule.confirm", "/api/agent/:agentID/schedule/:id/confirm", {
        params: { agentID: Schema.String, id: Schema.String },
        payload: ConfirmInput,
        success: Fire,
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.schedule.confirm",
          summary: "Confirm a scheduled window",
          description: "Mark one occurrence of an agent's task complete before its window closes.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "schedule", description: "Agent work windows and completion." }))
