import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import type { SessionWorkerCapabilities } from "../../src/session-worker/capabilities"
import { SessionWorkerInteractionBridge } from "../../src/session-worker/interaction-bridge"
import { SessionWorkerServices } from "../../src/session-worker/services"

test("owner delivery survives host, wire and worker without becoming a dormant model request", async () => {
  const lease = {
    sessionID: SessionSchema.ID.make("ses_owner_sender"),
    attemptID: "exe_owner_question",
    generation: 1,
    ownerID: "host",
  }
  const delivered = { delivered: true, started: false, human: true, recipient: "owner", redirected: false }
  const calls: unknown[] = []
  const services = SessionWorkerServices.make({
    colleague: async (input) => {
      const reply = await Effect.runPromise(
        SessionWorkerInteractionBridge.handle({
          lease,
          permission: {} as never,
          spawner: {} as never,
          join: {} as never,
          colleague: {
            deliver: (request) => {
              calls.push(request)
              return Effect.succeed(delivered)
            },
          } as ColleagueHandoff.Interface,
          message: { ...lease, version: 1, type: "colleague-request", requestID: "question", input },
        }),
      )
      const wire = SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(reply))
      if (!wire.ok || wire.message.type !== "colleague-result") throw new Error("Invalid colleague reply")
      return wire.message
    },
  } as Pick<SessionWorkerCapabilities.Capabilities, "colleague"> as SessionWorkerCapabilities.Capabilities)
  const result = await Effect.runPromise(
    services.colleague.deliver({ from: lease.sessionID, colleague: "owner", message: "Which destination?" }),
  )
  expect(calls).toEqual([{ from: lease.sessionID, colleague: "owner", message: "Which destination?" }])
  expect(result).toMatchObject(delivered)
})
