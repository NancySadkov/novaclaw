import { expect, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { Catalog } from "@novaclaw/core/catalog"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerEventBridge } from "./event-bridge"

const sessionID = SessionSchema.ID.make("ses_worker_event_bridge")
const lease = { sessionID, attemptID: "exe_event_bridge", generation: 4, ownerID: "host" }
const location = Location.Ref.make({ directory: AbsolutePath.make("C:/project") })
const published: Array<{ type: string; data: unknown; location?: Location.Ref }> = []
const events = EventV2.Service.of({
  publish: (definition, data, options) =>
    Effect.sync(() => {
      published.push({ type: definition.type, data, location: options?.location })
      return {
        id: EventV2.ID.create(),
        type: definition.type,
        data,
        location: options?.location,
        ...(definition.durable
          ? { durable: { aggregateID: sessionID, seq: published.length - 1, version: definition.durable.version } }
          : {}),
      } as EventV2.Payload<typeof definition>
    }),
  subscribe: () => Stream.empty,
  all: () => Stream.empty,
  durable: () => Stream.empty,
  listen: () => Effect.succeed(Effect.void),
  project: () => Effect.void,
  replay: () => Effect.void,
  replayAll: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  claim: () => Effect.void,
})

const request = (data: unknown, eventType: string = SessionEvent.Synthetic.type) => ({
  version: 1 as const,
  type: "publish-event" as const,
  sessionID,
  attemptID: lease.attemptID,
  generation: lease.generation,
  requestID: "rpc_1",
  eventType,
  data,
})

test("host validates, orders, and stamps a worker session event", async () => {
  const data = {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: 1234,
    text: "worker progress",
  }
  const reply = await Effect.runPromise(
    SessionWorkerEventBridge.publish({ events, lease, location, message: request(data) }),
  )
  expect(reply.type).toBe("event-published")
  expect(reply).toHaveProperty("durable.seq", 0)
  expect(published).toEqual([
    { type: SessionEvent.Synthetic.type, data: { ...data, timestamp: DateTime.makeUnsafe(1234) }, location },
  ])
})

test("host accepts non-session events from the server manifest", async () => {
  const reply = await Effect.runPromise(
    SessionWorkerEventBridge.publish({
      events,
      lease,
      location,
      message: request({}, Catalog.Event.Updated.type),
    }),
  )
  expect(reply.type).toBe("event-published")
  expect(published.at(-1)).toEqual({ type: Catalog.Event.Updated.type, data: {}, location })
})

test("host rejects unknown, malformed, cross-session, and stale event requests", async () => {
  const valid = {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: 1234,
    text: "worker progress",
  }
  const cases = [
    request(valid, "session.invented"),
    request({ sessionID }),
    request({ ...valid, sessionID: SessionSchema.ID.make("ses_other") }),
    { ...request(valid), generation: lease.generation - 1 },
  ]
  for (const message of cases) {
    const reply = await Effect.runPromise(SessionWorkerEventBridge.publish({ events, lease, location, message }))
    expect(reply.type).toBe("event-rejected")
  }
})
