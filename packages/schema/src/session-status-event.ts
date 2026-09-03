export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
    // Live-only progress for the transcript's expandable receipt. The durable twin lands on the
    // assistant message at Step.Ended; status updates explain pre-token work before that row exists.
    timing: optional(Schema.suspend(() => SessionMessage.TurnTiming)),
  }),
  // Terminal state (K1): the session called exit(result) — done, never busy again. Lets ps/task
  // managers show exited threads instead of inferring it from `result !== undefined`.
  Schema.Struct({
    type: Schema.Literal("exited"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  identifier: "SessionStatusEvent",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

export const Definitions = Event.inventory(Status)
