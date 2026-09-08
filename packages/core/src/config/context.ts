export * as ConfigContext from "./context"

import { Schema } from "effect"

const Share = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

/** Independent share ceilings, expressed as percentages of the model's full context window.
 * They need not sum to 100: system instructions and the task anchor may deliberately borrow past
 * their line, while unused shares are available to the ordinary total-window packer. */
export class Profile extends Schema.Class<Profile>("ConfigV2.Context.Profile")({
  system: Share.pipe(Schema.optional),
  messages: Share.pipe(Schema.optional),
  retrieval: Share.pipe(Schema.optional),
  memory: Share.pipe(Schema.optional),
  tool_output: Share.pipe(Schema.optional),
}) {}

export class Profiles extends Schema.Class<Profiles>("ConfigV2.Context.Profiles")({
  interactive: Profile.pipe(Schema.optional),
  "sub-agent": Profile.pipe(Schema.optional),
  "auto-prompting": Profile.pipe(Schema.optional),
  "goal-oriented": Profile.pipe(Schema.optional),
}) {}

export class TodoReminder extends Schema.Class<TodoReminder>("ConfigV2.Context.TodoReminder")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Periodically put the session checklist back into the model's working context (default true)",
  }),
  cadence: Schema.Finite.pipe(Schema.optional).annotate({
    description: "Durable session messages between checklist reminders (default 6)",
  }),
  max_tokens: Schema.Finite.pipe(Schema.optional).annotate({
    description: "Maximum estimated tokens in one checklist reminder (default 256)",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Context")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  profiles: Profiles.pipe(Schema.optional),
  todo_reminder: TodoReminder.pipe(Schema.optional),
}) {}
