export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { SessionEvent } from "./session-event"
import { SessionRecordEvent } from "./session-record-event"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

export const Durable = Event.durable([
  ...SessionRecordEvent.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
])
