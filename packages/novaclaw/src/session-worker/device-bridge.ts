export * as SessionWorkerDeviceBridge from "./device-bridge"

import { Effect } from "effect"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import type { SessionScheduler } from "@novaclaw/core/session/scheduler"

export type Request = Extract<
  SessionWorkerProtocol.WorkerMessage,
  {
    readonly type:
      | "device-admit"
      | "device-release"
      | "device-report"
      | "device-maintenance-admit"
      | "device-maintenance-release"
      | "device-maintenance-await-preemption"
  }
>
export type Reply = Extract<
  SessionWorkerProtocol.HostMessage,
  {
    readonly type:
      | "device-admitted"
      | "device-released"
      | "device-reported"
      | "device-maintenance-admitted"
      | "device-maintenance-released"
      | "device-maintenance-preempted"
      | "device-rejected"
  }
>

const identity = (message: Request) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
})

const rejected = (message: Request, error: string): Reply => ({ ...identity(message), type: "device-rejected", error })

/** The host is the only scheduler owner. Worker-supplied session IDs never reach the scheduler;
 * the fenced lease supplies that identity, and worker exit separately evicts it from every queue. */
export const handle = Effect.fn("SessionWorkerDeviceBridge.handle")(function* (input: {
  readonly scheduler: SessionScheduler.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Request
}) {
  if (!SessionWorkerProtocol.owns(input.lease, input.message))
    return rejected(input.message, "execution ownership changed")
  if (!input.message.deviceKey.trim()) return rejected(input.message, "device key is empty")

  switch (input.message.type) {
    case "device-admit":
      yield* input.scheduler.admit({
        sessionID: input.lease.sessionID,
        deviceKey: input.message.deviceKey,
        sessionClass: input.message.sessionClass,
        ...(input.message.priority === undefined ? {} : { priority: input.message.priority }),
        ...(input.message.concurrency === undefined ? {} : { concurrency: input.message.concurrency }),
        ...(input.message.locality === undefined ? {} : { locality: input.message.locality }),
      })
      return { ...identity(input.message), type: "device-admitted" as const }
    case "device-release":
      yield* input.scheduler.release({ sessionID: input.lease.sessionID, deviceKey: input.message.deviceKey })
      return { ...identity(input.message), type: "device-released" as const }
    case "device-report":
      if (input.message.costTokens < 0) return rejected(input.message, "device cost cannot be negative")
      yield* input.scheduler.report({
        sessionID: input.lease.sessionID,
        deviceKey: input.message.deviceKey,
        costTokens: input.message.costTokens,
      })
      return { ...identity(input.message), type: "device-reported" as const }
    case "device-maintenance-admit": {
      const lease = yield* input.scheduler.admitMaintenance({
        ownerID: input.lease.sessionID,
        task: input.message.task,
        deviceKey: input.message.deviceKey,
        ...(input.message.concurrency === undefined ? {} : { concurrency: input.message.concurrency }),
        ...(input.message.locality === undefined ? {} : { locality: input.message.locality }),
      })
      return {
        ...identity(input.message),
        type: "device-maintenance-admitted" as const,
        maintenanceID: lease.maintenanceID,
      }
    }
    case "device-maintenance-release":
      yield* input.scheduler.releaseMaintenance({
        ownerID: input.lease.sessionID,
        lease: {
          maintenanceID: input.message.maintenanceID,
          sessionID: input.message.maintenanceID,
          deviceKey: input.message.deviceKey,
        },
      })
      return { ...identity(input.message), type: "device-maintenance-released" as const }
    case "device-maintenance-await-preemption":
      yield* input.scheduler.awaitMaintenancePreemption({
        ownerID: input.lease.sessionID,
        lease: {
          maintenanceID: input.message.maintenanceID,
          sessionID: input.message.maintenanceID,
          deviceKey: input.message.deviceKey,
        },
      })
      return { ...identity(input.message), type: "device-maintenance-preempted" as const }
  }
})

export const reclaim = (scheduler: SessionScheduler.Interface, lease: SessionExecutionAttempt.Lease) =>
  scheduler.evict(lease.sessionID)
