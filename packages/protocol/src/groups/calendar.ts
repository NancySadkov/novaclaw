import { Context, Schema } from "effect"
import { PermissionMode } from "@novaclaw/schema/session-message"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

// The Calendar / cron-session-creator HTTP surface. Schedules and fire
// history are INSTANCE-GLOBAL: listing, removal and history never acquire a location. The two write
// endpoints do acquire the request's location so a named agent/model can be checked where the caller
// is working when the schedule does not pin its own folder. Backed by CalendarStore
// (core/schedule/store.ts); the CalendarScheduler poll loop fires due schedules into new goal-oriented
// sessions. `recurrence` is a structured discriminated union (never a cron string — anti-obscurantist).

/**
 * ─── THE RUNNABLE DOMAIN ─────────────────────────────────────────────────────────────────────────
 *
 * 🔴 **The wire's recurrence is the ENGINE's recurrence, and these bounds are why.** The scheduler
 * (`core/schedule/recurrence.ts`) reads a wall clock: `Weekday` is `0..6`, an hour is `0..23`, a
 * minute `0..59`, a day-of-month `1..31`, a month `1..12`. Anything outside that is not a schedule
 * the engine runs slightly wrong — it is a schedule that **never fires**, stored and answered `201`.
 * `nextFire` scans 800 days, `matchesDay` is never true, `next_fire_at` is written `null`, and the
 * row sits in the Calendar app reading `enabled: true` forever. `weekdays: [7]`, `weekdays: []` and
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

const HM = Schema.Struct({ hour: Hour, minute: Minute })

/**
 * Exported so the guard has a NAME to hold. `server/src/handlers/calendar-recurrence-domain.test.ts`
 * decodes fixtures through these and hands the result straight to `Recurrence.nextFire` with no cast
 * — which is the assertion: every recurrence this wire accepts is one the engine can run.
 */
export const Recurrence = Schema.Union([
  // A non-finite instant is never `> after`, so it is the never-fires case wearing a number.
  Schema.Struct({ kind: Schema.Literals(["once"]), at: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literals(["daily"]), time: HM }),
  // An empty list matches no calendar day — the same defect spelled entirely with valid weekdays.
  Schema.Struct({
    kind: Schema.Literals(["weekly"]),
    time: HM,
    weekdays: Schema.Array(Weekday).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ kind: Schema.Literals(["monthly"]), time: HM, day: MonthDay }),
  Schema.Struct({ kind: Schema.Literals(["yearly"]), time: HM, month: Month, day: MonthDay }),
]).annotate({ identifier: "Calendar.Recurrence" })

export const Schedule = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  recurrence: Recurrence,
  tzOffsetMin: TzOffsetMin,
  prompt: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  /**
   * 🔴 The SAME closed set the create/update payloads take, and that is the whole point: a decode
   * guarantee has a DIRECTION, and this one used to exist only inbound. Declared as
   * `Schema.String` here, the vocabulary the runner switches on was unenforceable on the way out —
   * a generated client's `Schedule.permissionMode` could not be assigned to
   * `CreateInput.permissionMode`, so round-tripping a fetched schedule through PATCH did not
   * typecheck, and any row not written through this contract read back as a mode no client could
   * map. One symbol on both sides is what makes the two impossible to drift apart.
   */
  permissionMode: Schema.NullOr(PermissionMode),
  enabled: Schema.Boolean,
  nextFireAt: Schema.NullOr(Schema.Finite),
  lastFiredAt: Schema.NullOr(Schema.Finite),
  timeCreated: Schema.Finite,
  timeUpdated: Schema.Finite,
}).annotate({ identifier: "Calendar.Schedule" })

const Fire = Schema.Struct({
  id: Schema.String,
  scheduleId: Schema.String,
  occurrenceMillis: Schema.Finite,
  firedAt: Schema.Finite,
  sessionId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["spawned", "skipped", "error"]),
  outcome: Schema.Literals(["pending", "succeeded", "failed", "interrupted"]),
}).annotate({ identifier: "Calendar.Fire" })

export const CreateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  recurrence: Recurrence,
  tzOffsetMin: Schema.optional(TzOffsetMin),
  prompt: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  /** The kernel's own literal set, so this cannot drift from what the runner accepts. */
  permissionMode: Schema.optional(PermissionMode),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Calendar.CreateInput" })

// Every field optional — the common case is a one-field pause/resume (`enabled`). An omitted field is
// left untouched; the store recomputes next_fire_at from whatever the merged recurrence/tz/enabled are.
const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  recurrence: Schema.optional(Recurrence),
  tzOffsetMin: Schema.optional(TzOffsetMin),
  prompt: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  location: Schema.optional(Schema.NullOr(Schema.String)),
  // Same closed vocabulary as create; `null` clears the override.
  permissionMode: Schema.optional(Schema.NullOr(PermissionMode)),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Calendar.UpdateInput" })

/**
 * The group is a factory because only its write endpoints need the concrete location middleware.
 * Applying middleware to the completed group would incorrectly make instance-wide reads location
 * scoped; leaving it off the writes would make their ambient fallback the server process directory.
 */
export const makeCalendarGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApiGroup.make("server.calendar")
    .add(
      HttpApiEndpoint.get("calendar.schedule.list", "/api/calendar/schedule", {
        success: Schema.Array(Schedule),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.calendar.schedule.list",
          summary: "List calendar schedules",
          description: "Retrieve every scheduled agent-launch task with its next-fire time.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("calendar.schedule.create", "/api/calendar/schedule", {
        payload: CreateInput,
        success: Schedule,
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.calendar.schedule.create",
            summary: "Create a calendar schedule",
            description:
              "Schedule a repeatable or one-shot agent launch. The recurrence is structured (once/daily/weekly/monthly/yearly); the fired session runs the given prompt.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("calendar.schedule.update", "/api/calendar/schedule/:id", {
        params: { id: Schema.String },
        payload: UpdateInput,
        success: Schedule,
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.calendar.schedule.update",
            summary: "Update a calendar schedule",
            description:
              "Patch a scheduled agent-launch task — pause/resume it (enabled), or change its title, prompt, recurrence, model, folder, or permission mode. The next-fire time is recomputed; a disabled schedule has none.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("calendar.schedule.remove", "/api/calendar/schedule/:id", {
        params: { id: Schema.String },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.calendar.schedule.remove",
          summary: "Remove a calendar schedule",
          description: "Delete a scheduled agent-launch task by id.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("calendar.fires.list", "/api/calendar/fires", {
        success: Schema.Array(Fire),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.calendar.fires.list",
          summary: "List recent schedule fires",
          description: "Recent scheduled-launch fires across all schedules, newest first (the run history).",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "calendar", description: "Scheduled + repeatable agent launches." }))
