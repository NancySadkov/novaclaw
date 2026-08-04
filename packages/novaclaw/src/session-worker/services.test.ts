import { expect, test } from "bun:test"
import { Cause, DateTime, Effect, Exit } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { Catalog } from "@novaclaw/core/catalog"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerServices } from "./services"
import type { SessionWorkerCapabilities } from "./capabilities"

const sessionID = SessionSchema.ID.make("ses_worker_services")

test("encodes event data for the wire and refuses process-local commit callbacks", async () => {
  let wireData: unknown
  const services = SessionWorkerServices.make({
    publishEvent: async (_type: string, data: unknown) => {
      wireData = data
      return {
        version: 1,
        type: "event-published",
        sessionID,
        attemptID: "exe_services",
        generation: 1,
        requestID: "rpc_services",
        eventID: EventV2.ID.create(),
      }
    },
  } as unknown as SessionWorkerCapabilities.Capabilities)
  const data = {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: DateTime.makeUnsafe(1234),
    text: "encoded",
  }
  await Effect.runPromise(services.events.publish(SessionEvent.Synthetic, data))
  expect((wireData as { timestamp: number }).timestamp).toBe(1234)
  await expect(
    Effect.runPromise(services.events.publish(SessionEvent.Synthetic, data, { commit: () => Effect.void })),
  ).rejects.toThrow("event commit callback is host-only")
})

test("forwards server catalog boot events through the host-owned event bridge", async () => {
  let publications = 0
  const services = SessionWorkerServices.make({
    publishEvent: async () => {
      publications++
      return {
        version: 1,
        type: "event-published",
        sessionID,
        attemptID: "exe_services",
        generation: 1,
        requestID: "rpc_services",
        eventID: EventV2.ID.create(),
      }
    },
  } as unknown as SessionWorkerCapabilities.Capabilities)
  const event = await Effect.runPromise(services.events.publish(Catalog.Event.Updated, {}))
  expect(event.type).toBe("catalog.updated")
  expect(publications).toBe(1)
})

test("restores permission denial identity from the host reply", async () => {
  const services = SessionWorkerServices.make({
    assertPermission: async () => ({
      version: 1,
      type: "permission-result",
      sessionID,
      attemptID: "exe_services",
      generation: 1,
      requestID: "rpc_services",
      outcome: "denied",
      rules: [{ action: "write", resource: "*", effect: "deny" }],
    }),
  } as unknown as SessionWorkerCapabilities.Capabilities)
  const result = await Effect.runPromiseExit(
    services.permission.assert({ sessionID, action: "write", resources: ["outside.txt"] }),
  )
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBeInstanceOf(PermissionV2.DeniedError)
})
