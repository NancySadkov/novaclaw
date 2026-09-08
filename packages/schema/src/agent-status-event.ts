export * as AgentStatusEvent from "./agent-status-event"

import { Schema } from "effect"
import { Event } from "./event"

/** A colleague's one-line task component changed. Non-durable: SQLite is the source of truth. */
export const Updated = Event.define({
  type: "agent.status.updated",
  schema: {
    agent: Schema.String,
    task: Schema.String,
    observed: Schema.Finite,
  },
})

/** A colleague's chat was cleared, so its current task component no longer exists. */
export const Removed = Event.define({
  type: "agent.status.removed",
  schema: {
    agent: Schema.String,
  },
})

export const Definitions = Event.inventory(Updated, Removed)
