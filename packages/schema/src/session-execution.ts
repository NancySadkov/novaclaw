export * as SessionExecution from "./session-execution"

import { Schema } from "effect"
import { Session } from "./session"

export const State = Schema.Literals(["starting", "busy", "recovering", "paused", "failed", "interrupted", "settled"])
export const Phase = Schema.Literals(["drain", "provider", "tool", "maintenance"])

export const Info = Schema.Struct({
  sessionID: Session.ID,
  attemptID: Schema.String,
  generation: Schema.Finite,
  ownerID: Schema.String,
  state: State,
  phase: Phase,
  /**
   * 🔴 Whether a stop is still in flight for this session — the thread manager's own flag
   * (owner, 2026-09-26). Written by no row: the coordinator sets it on `interrupt` and clears
   * it when the entry settles, and `session.execution.list` joins it onto the durable attempt.
   * The scheduler acts on it; the Stop button renders its spinner from it. One state, sampled
   * twice — never a client-local second opinion an unsettled stop could hide behind.
   */
  stopping: Schema.Boolean,
  heartbeatAt: Schema.Finite,
  checkpointAt: Schema.optional(Schema.Finite),
  failureClass: Schema.optional(Schema.String),
  failureDetail: Schema.optional(Schema.String),
  failureCount: Schema.Finite,
  toolCallID: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  toolSideEffect: Schema.optional(Schema.Literals(["read", "idempotent-write", "non-idempotent", "external-unknown"])),
  toolState: Schema.optional(Schema.Literals(["dispatched", "settled"])),
  startedAt: Schema.Finite,
  updatedAt: Schema.Finite,
}).annotate({ identifier: "Session.Execution" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
