export * as SessionWorkerEventBridge from "./event-bridge"

import { Effect, Schema } from "effect"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import type { EventV2 } from "@novaclaw/core/event"
import type { Location } from "@novaclaw/core/location"

type Publish = Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "publish-event" }>
type Reply = Extract<SessionWorkerProtocol.HostMessage, { readonly type: "event-published" | "event-rejected" }>

// `session.status` is in `ServerDefinitions` since 2026-09-03; the bridge forwards the served set.
const workerDefinitions: ReadonlyArray<(typeof EventManifest.Definitions)[number]> = [
  ...EventManifest.ServerDefinitions,
]
const definitions: ReadonlyMap<string, (typeof EventManifest.Definitions)[number]> = new Map(
  workerDefinitions.map((definition) => [definition.type, definition]),
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
  readonly attempts: Pick<SessionExecutionAttempt.Interface, "owns">
  readonly lease: SessionExecutionAttempt.Lease
  readonly location: Location.Ref
  readonly message: Publish
}) {
  // Envelope identity alone only proves the message came from the worker this callback was created
  // for. After a retry replaces the durable lease, that old callback can still be draining an RPC;
  // without the database fence it appended a late tool label to Geryon's replacement generation.
  if (!SessionWorkerProtocol.owns(input.lease, input.message) || !(yield* input.attempts.owns(input.lease)))
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
