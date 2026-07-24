import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

// The Calendar / cron-session-creator HTTP surface (notes/calendar-cron-plan.md). INSTANCE-GLOBAL
// (schedules span locations, like messenger accounts — no location middleware). Backed by CalendarStore
// (core/schedule/store.ts); the CalendarScheduler poll loop fires due schedules into new goal-oriented
// sessions. `recurrence` is a structured discriminated union (never a cron string — anti-obscurantist).

const HM = Schema.Struct({ hour: Schema.Number, minute: Schema.Number })

const Recurrence = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["once"]), at: Schema.Number }),
  Schema.Struct({ kind: Schema.Literals(["daily"]), time: HM }),
  Schema.Struct({ kind: Schema.Literals(["weekly"]), time: HM, weekdays: Schema.Array(Schema.Number) }),
  Schema.Struct({ kind: Schema.Literals(["monthly"]), time: HM, day: Schema.Number }),
  Schema.Struct({ kind: Schema.Literals(["yearly"]), time: HM, month: Schema.Number, day: Schema.Number }),
]).annotate({ identifier: "Calendar.Recurrence" })

const Schedule = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  recurrence: Recurrence,
  tzOffsetMin: Schema.Number,
  prompt: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  permissionMode: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  nextFireAt: Schema.NullOr(Schema.Number),
  lastFiredAt: Schema.NullOr(Schema.Number),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "Calendar.Schedule" })

const Fire = Schema.Struct({
  id: Schema.String,
  scheduleId: Schema.String,
  occurrenceMillis: Schema.Number,
  firedAt: Schema.Number,
  sessionId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["spawned", "skipped", "error"]),
}).annotate({ identifier: "Calendar.Fire" })

const CreateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  recurrence: Recurrence,
  tzOffsetMin: Schema.optional(Schema.Number),
  prompt: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Calendar.CreateInput" })

// Every field optional — the common case is a one-field pause/resume (`enabled`). An omitted field is
// left untouched; the store recomputes next_fire_at from whatever the merged recurrence/tz/enabled are.
const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  recurrence: Schema.optional(Recurrence),
  tzOffsetMin: Schema.optional(Schema.Number),
  prompt: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  location: Schema.optional(Schema.NullOr(Schema.String)),
  permissionMode: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Calendar.UpdateInput" })

export const CalendarGroup = HttpApiGroup.make("server.calendar")
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
    }).annotateMerge(
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
    }).annotateMerge(
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
  .annotateMerge(
    OpenApi.annotations({ title: "calendar", description: "Scheduled + repeatable agent launches." }),
  )
