export * as DurableEventManifest from "./durable-event-manifest"

import { Event } from "./event"
import { SessionEvent } from "./session-event"
import { SessionRecordEvent } from "./session-record-event"

export const SessionDurable: {
  readonly definitions: ReadonlyMap<string, Event.Definition>
  readonly schema: typeof SessionEvent.Durable
} = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
}

export const Durable = Event.durable([
  ...SessionRecordEvent.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
])
