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
  expect(capabilities.execution.fence).toEqual({ attemptID: lease.attemptID, generation: lease.generation })
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

test("device scheduling facts cross the worker protocol intact", async () => {
  let sent: SessionWorkerClient.Request | undefined
  const client = SessionWorkerClient.make({
    lease,
    send: (message) => {
      sent = message
      queueMicrotask(() => client.accept({ ...identity, type: "device-admitted", requestID: message.requestID }))
    },
  })
  await SessionWorkerCapabilities.make({ lease, client }).admitDevice({
    deviceKey: "spark",
    sessionClass: "sub-agent",
    concurrency: 7,
    locality: "lan",
  })
  expect(sent).toMatchObject({ type: "device-admit", deviceKey: "spark", concurrency: 7, locality: "lan" })
})

test("maintenance leases cross as opaque host-owned ids and release through their own RPC", async () => {
  const sent: SessionWorkerClient.Request[] = []
  const client = SessionWorkerClient.make({
    lease,
    send: (message) => {
      sent.push(message)
      queueMicrotask(() => {
        if (message.type === "device-maintenance-admit")
          client.accept({
            ...identity,
            type: "device-maintenance-admitted",
            requestID: message.requestID,
            maintenanceID: "maintenance:host-owned",
          })
        else if (message.type === "device-maintenance-release")
          client.accept({
            ...identity,
            type: "device-maintenance-released",
            requestID: message.requestID,
          })
        else if (message.type === "device-maintenance-await-preemption")
          client.accept({
            ...identity,
            type: "device-maintenance-preempted",
            requestID: message.requestID,
          })
      })
    },
  })
  const capabilities = SessionWorkerCapabilities.make({ lease, client })
  const admitted = await capabilities.admitMaintenance({
    task: "memory-extract",
    deviceKey: "spark",
    concurrency: 4,
    locality: "lan",
  })
  expect(admitted).toEqual({
    maintenanceID: "maintenance:host-owned",
    sessionID: "maintenance:host-owned",
    deviceKey: "spark",
  })
  await capabilities.releaseMaintenance(admitted)
  await capabilities.awaitMaintenancePreemption(admitted)

  expect(sent[0]).toMatchObject({
    type: "device-maintenance-admit",
    sessionID: lease.sessionID,
    task: "memory-extract",
    deviceKey: "spark",
    concurrency: 4,
    locality: "lan",
  })
  expect(sent[1]).toMatchObject({
    type: "device-maintenance-release",
    sessionID: lease.sessionID,
    maintenanceID: "maintenance:host-owned",
    deviceKey: "spark",
  })
  expect(sent[2]).toMatchObject({
    type: "device-maintenance-await-preemption",
    sessionID: lease.sessionID,
    maintenanceID: "maintenance:host-owned",
    deviceKey: "spark",
  })
})
