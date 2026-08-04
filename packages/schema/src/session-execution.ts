export * as SessionExecution from "./session-execution"

import { Schema } from "effect"
import { Session } from "./session"

export const State = Schema.Literals(["starting", "busy", "recovering", "paused", "failed", "interrupted", "settled"])
export const Phase = Schema.Literals(["drain", "provider", "tool", "maintenance"])

export const Info = Schema.Struct({
  sessionID: Session.ID,
  attemptID: Schema.String,
  generation: Schema.Number,
  ownerID: Schema.String,
  state: State,
  phase: Phase,
  heartbeatAt: Schema.Number,
  checkpointAt: Schema.optional(Schema.Number),
  failureClass: Schema.optional(Schema.String),
  failureDetail: Schema.optional(Schema.String),
  failureCount: Schema.Number,
  toolCallID: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  toolSideEffect: Schema.optional(Schema.Literals(["read", "idempotent-write", "non-idempotent", "external-unknown"])),
  toolState: Schema.optional(Schema.Literals(["dispatched", "settled"])),
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Session.Execution" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
