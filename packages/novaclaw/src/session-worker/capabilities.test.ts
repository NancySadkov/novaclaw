import { expect, test } from "bun:test"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerClient } from "./client"
import { SessionWorkerCapabilities } from "./capabilities"

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_capabilities"),
  attemptID: "exe_worker_capabilities",
  generation: 2,
  ownerID: "host-test",
}
const identity = { version: 1 as const, ...lease }

test("stamps the fenced session identity onto interaction requests", async () => {
  let client!: ReturnType<typeof SessionWorkerClient.make>
  let sent: SessionWorkerClient.Request | undefined
  client = SessionWorkerClient.make({
    lease,
    send: (message) => {
      sent = message
      queueMicrotask(() => {
        client.accept({
          ...identity,
          type: "permission-result",
          requestID: message.requestID,
          outcome: "allowed",
        })
      })
    },
  })
  const capabilities = SessionWorkerCapabilities.make({ lease, client })
  const reply = await capabilities.assertPermission({
    sessionID: SessionSchema.ID.make("ses_forged"),
    action: "read",
    resources: ["README.md"],
  })
  expect(reply.outcome).toBe("allowed")
  expect(sent?.sessionID).toBe(lease.sessionID)
  expect(sent?.type).toBe("permission-assert")
  if (sent?.type === "permission-assert") expect(sent.input.sessionID).toBe(lease.sessionID)
})

test("turns host rejection into a worker-visible error", async () => {
  let client!: ReturnType<typeof SessionWorkerClient.make>
  client = SessionWorkerClient.make({
    lease,
    send: (message) => {
      queueMicrotask(() => {
        client.accept({ ...identity, type: "device-rejected", requestID: message.requestID, error: "device offline" })
      })
    },
  })
  await expect(
    SessionWorkerCapabilities.make({ lease, client }).admitDevice({
      deviceKey: "provider/model",
      sessionClass: "interactive",
    }),
  ).rejects.toThrow("device offline")
})

test("a scheduler object cannot overwrite the fenced session identity", async () => {
  let sent: SessionWorkerClient.Request | undefined
  const client = SessionWorkerClient.make({
    lease,
    send: (message) => {
      sent = message
      queueMicrotask(() => client.accept({ ...identity, type: "device-admitted", requestID: message.requestID }))
    },
  })
  const forged = {
    sessionID: SessionSchema.ID.make("ses_forged"),
    deviceKey: "provider/model",
    sessionClass: "interactive" as const,
  }
  await SessionWorkerCapabilities.make({ lease, client }).admitDevice(forged)
  expect(sent?.sessionID).toBe(lease.sessionID)
})
