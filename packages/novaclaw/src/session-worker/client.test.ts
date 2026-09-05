import { expect, test } from "bun:test"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { EventV2 } from "@novaclaw/core/event"
import { SessionWorkerClient } from "./client"

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_client"),
  attemptID: "exe_worker_client",
  generation: 3,
  ownerID: "host-test",
}
const identity = { version: 1 as const, ...lease }

const publish = (requestID: string): SessionWorkerClient.Request => ({
  ...identity,
  type: "publish-event",
  requestID,
  eventType: "session.next.synthetic",
  data: { sessionID: lease.sessionID },
})

test("correlates replies and leaves lifecycle messages for the entrypoint", async () => {
  const sent: SessionWorkerClient.Request[] = []
  const client = SessionWorkerClient.make({ lease, send: (message) => sent.push(message) })
  const result = client.request(publish("rpc_1"))
  expect(sent).toHaveLength(1)
  expect(client.accept({ ...identity, type: "interrupt" })).toBe(false)
  expect(
    client.accept({
      ...identity,
      type: "event-published",
      requestID: "rpc_1",
      eventID: EventV2.ID.create(),
    }),
  ).toBe(true)
  expect((await result).type).toBe("event-published")
  expect(client.pendingCount()).toBe(0)
})

test("rejects incompatible replies and all pending waits on close", async () => {
  const client = SessionWorkerClient.make({ lease, send: () => undefined })
  const first = client.request(publish("rpc_bad"))
  client.accept({ ...identity, type: "device-admitted", requestID: "rpc_bad" })
  await expect(first).rejects.toThrow("incompatible worker RPC")

  const closed = SessionWorkerClient.make({ lease, send: () => undefined })
  const waiting = closed.request(publish("rpc_waiting"))
  closed.close(new Error("worker stopping"))
  await expect(waiting).rejects.toThrow("worker stopping")
  expect(closed.pendingCount()).toBe(0)
})

// The abort half of this test went with the `AbortSignal` parameter on 2026-09-01 (): no
// production caller ever supplied one, and the path it exercised turned a cancelled call into a dead
// worker — abort dropped the pending entry while the host was still working, so the reply arrived
// unknown and `accept` closed the transport, failing every other in-flight RPC. The stale-identity
// half is unrelated and stays.
test("stale identity never sends", async () => {
  let sends = 0
  const client = SessionWorkerClient.make({ lease, send: () => sends++ })
  // Left deliberately pending — no reply arrives in this test; it is the thing `sends` counts.
  const inflight = client.request(publish("rpc_ok"))
  expect(client.pendingCount()).toBe(1)

  await expect(client.request({ ...publish("rpc_stale"), generation: lease.generation - 1 })).rejects.toThrow(
    "stale RPC",
  )
  expect(sends).toBe(1)

  client.close(new Error("worker stopping"))
  await expect(inflight).rejects.toThrow("worker stopping")
})
