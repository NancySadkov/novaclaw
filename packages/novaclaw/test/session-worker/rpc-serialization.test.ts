import { expect, test } from "bun:test"
import path from "node:path"
import { EventV2 } from "@novaclaw/core/event"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { spawn } from "../../src/session-worker/supervisor"

/**
 * **What may share the supervisor's serial RPC chain.**
 *
 * The chain exists for ONE property: an RPC that writes the host's ordered record for this session
 * (`publish-event`, `execution-*`) must not be overtaken by the next one. Anything that can block on
 * something outside the worker — a human answering a permission dialog, a child session, a device
 * lease — writes no ordered record and must not sit on that chain, because while it is parked there
 * every ordered write behind it is parked too.
 *
 * The first case drives both at once and asserts the ordered write makes progress WHILE the blocking
 * one is still blocked. The second is the control: the ordering the chain exists for still holds.
 */

const fixture = path.resolve(import.meta.dir, "../fixtures/session-worker.ts")
const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_rpc_serialization"),
  attemptID: "exe_worker_rpc_serialization",
  generation: 1,
  ownerID: "host-test",
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("a blocking interaction RPC does not stall a concurrent ordered publication", async () => {
  let publicationReached!: () => void
  const publicationStarted = new Promise<void>((resolve) => {
    publicationReached = resolve
  })
  let permissionBlocked = false
  let publicationSawPermissionBlocked = false

  const worker = spawn({
    command: [process.execPath, fixture, "blocking-interaction"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    // Long enough that the assertion below is what fails when the defect is present, rather than a
    // liveness deadline firing first and reporting an unrelated outcome.
    heartbeatTimeoutMs: 20_000,
    onInteractionRequest: async (message) => {
      permissionBlocked = true
      // ⚠️ BOUNDED. With the two requests sharing one chain this promise is never resolved, and an
      // unbounded await here would hang the suite instead of failing it.
      await Promise.race([publicationStarted, delay(3_000)])
      permissionBlocked = false
      return {
        version: 1,
        type: "permission-result",
        sessionID: message.sessionID,
        attemptID: message.attemptID,
        generation: message.generation,
        requestID: message.requestID,
        outcome: "allowed",
      }
    },
    onPublishEvent: async (message) => {
      publicationSawPermissionBlocked = permissionBlocked
      publicationReached()
      return {
        version: 1,
        type: "event-published",
        sessionID: message.sessionID,
        attemptID: message.attemptID,
        generation: message.generation,
        requestID: message.requestID,
        eventID: EventV2.ID.create(),
      }
    },
  })

  expect(await worker.result).toEqual({ type: "settled" })
  expect(publicationSawPermissionBlocked).toBe(true)
}, 20_000)

test("ordered publications still cannot overtake one another", async () => {
  const order: string[] = []
  const worker = spawn({
    command: [process.execPath, fixture, "publish"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 20_000,
    onPublishEvent: async (message) => {
      order.push(`enter:${message.requestID}`)
      // A publication that awaits disk. The second must not begin until this one has finished, or
      // it could receive an earlier durable sequence than the event that preceded it.
      if (message.requestID === "rpc_1") await delay(150)
      order.push(`exit:${message.requestID}`)
      return {
        version: 1,
        type: "event-published",
        sessionID: message.sessionID,
        attemptID: message.attemptID,
        generation: message.generation,
        requestID: message.requestID,
        eventID: EventV2.ID.create(),
      }
    },
  })

  expect(await worker.result).toEqual({ type: "settled" })
  expect(order).toEqual(["enter:rpc_1", "exit:rpc_1", "enter:rpc_2", "exit:rpc_2"])
}, 20_000)
