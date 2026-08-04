export * as SessionWorkerEventBridge from "./event-bridge"

import { Effect, Schema } from "effect"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import type { EventV2 } from "@novaclaw/core/event"
import type { Location } from "@novaclaw/core/location"

type Publish = Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "publish-event" }>
type Reply = Extract<SessionWorkerProtocol.HostMessage, { readonly type: "event-published" | "event-rejected" }>

const definitions: ReadonlyMap<string, (typeof EventManifest.ServerDefinitions)[number]> = new Map(
  EventManifest.ServerDefinitions.map((definition) => [definition.type, definition]),
)

const identity = (message: Publish) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
})

const rejected = (message: Publish, error: string): Reply => ({
  ...identity(message),
  type: "event-rejected",
  error,
})

/** Validate and publish one worker event on the HOST event bus. The child chooses neither its
 * location nor aggregate identity, and schema diagnostics are not reflected across the boundary. */
export const publish = Effect.fn("SessionWorkerEventBridge.publish")(function* (input: {
  readonly events: EventV2.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly location: Location.Ref
  readonly message: Publish
}) {
  if (!SessionWorkerProtocol.owns(input.lease, input.message))
    return rejected(input.message, "execution ownership changed")
  const definition = definitions.get(input.message.eventType)
  if (!definition) return rejected(input.message, "unknown server event type")
  let data: unknown
  try {
    data = Schema.decodeUnknownSync(definition.data)(input.message.data)
  } catch {
    return rejected(input.message, "server event payload is invalid")
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "sessionID" in data &&
    (data as { readonly sessionID?: unknown }).sessionID !== input.lease.sessionID
  )
    return rejected(input.message, "session event does not belong to this worker")

  // Dynamic lookup is the boundary: `definition.data` has just decoded `data`. Past this line the
  // ordinary EventV2 publisher assigns the event id/aggregate sequence and runs projections.
  const event = yield* input.events.publish(definition, data as never, {
    location: input.location,
    ...(input.message.metadata === undefined ? {} : { metadata: input.message.metadata }),
  })
  return {
    ...identity(input.message),
    type: "event-published" as const,
    eventID: event.id,
    ...(event.durable === undefined ? {} : { durable: event.durable }),
  }
})
