export * as SessionWorkerCapabilities from "./capabilities"

import type { PermissionV2 } from "@novaclaw/core/permission"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import type { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import { SessionProviderRecovery } from "@novaclaw/schema/session-provider-recovery"
import { DateTime, Effect } from "effect"
import type { Client, Reply } from "./client"

export interface Capabilities {
  readonly publishEvent: (
    eventType: string,
    data: unknown,
    metadata?: Readonly<Record<string, unknown>>,
  ) => Promise<Extract<Reply, { readonly type: "event-published" }>>
  readonly admitDevice: (input: Omit<SessionScheduler.AdmitInput, "sessionID">) => Promise<void>
  readonly releaseDevice: (input: Omit<SessionScheduler.ReleaseInput, "sessionID">) => Promise<void>
  readonly reportDevice: (input: Omit<SessionScheduler.ReportInput, "sessionID">) => Promise<void>
  readonly admitMaintenance: (
    input: Omit<SessionScheduler.MaintenanceInput, "ownerID">,
  ) => Promise<SessionScheduler.MaintenanceLease>
  readonly releaseMaintenance: (input: SessionScheduler.MaintenanceLease) => Promise<void>
  readonly awaitMaintenancePreemption: (input: SessionScheduler.MaintenanceLease) => Promise<void>
  readonly assertPermission: (
    input: PermissionV2.AssertInput,
  ) => Promise<Extract<Reply, { readonly type: "permission-result" }>>
  /**
   * Spawn a child of THIS session.
   *
   * ⚠️ No `parentID` — see `SpawnChild` in the protocol. The host uses the lease's session id, so a
   * worker can spawn children of itself and of nothing else, structurally rather than by a check.
   */
  readonly spawnChild: (
    input: SessionWorkerProtocol.SpawnChildInput,
  ) => Promise<Extract<Reply, { readonly type: "spawn-result" }>>
  /**
   * Hand work to a COLLEAGUE — a peer agent's own chat, delivered host-side.
   *
   * ⚠️ No sender field: the host stamps it from the lease, so a worker speaks as itself and as
   * nobody else. Same discipline as `spawnChild`'s absent `parentID` — there is no field to forge.
   */
  readonly colleague: (
    input: SessionWorkerProtocol.ColleagueRequestInput,
  ) => Promise<Extract<Reply, { readonly type: "colleague-result" }>>
  /**
   * One memory operation, performed by the HOST's single engine.
   *
   * ⚠️ No scope field to forge here either, but for a different reason than `spawnChild` and
   * `colleague`: the access set IS an argument, because the `kb` tool builds it from the session it
   * runs in and the host cannot re-derive that. What the host does instead is REFUSE a malformed one
   * — see `memory-bridge.ts`, where `scopes: undefined` means every scope and a field lost in
   * transit would silently widen the caller's reach.
   */
  readonly memory: (
    op: SessionWorkerProtocol.MemoryOp,
    args: ReadonlyArray<unknown>,
  ) => Promise<Extract<Reply, { readonly type: "memory-result" }>>
  /** The same RPC surface, routed to the host's separate automatic world-model graph. */
  readonly worldMemory: (
    op: SessionWorkerProtocol.MemoryOp,
    args: ReadonlyArray<unknown>,
  ) => Promise<Extract<Reply, { readonly type: "memory-result" }>>
  /**
   * One managed-local-model operation, performed by the HOST's single runtime.
   *
   * `ensure` runs on every provider turn. A worker that built its own runtime spawned a second
   * `llama-server` on the same fixed port — or owned the only one and had it tree-killed with the
   * worker at the end of the turn. `local-model-bridge.ts` is the other end.
   */
  readonly localModel: (
    op: SessionWorkerProtocol.LocalModelOp,
    args: ReadonlyArray<unknown>,
  ) => Promise<Extract<Reply, { readonly type: "local-model-result" }>>
  /**
   * The runner's cross-drain facts, read from and written to the HOST's store. One worker is one
   * drain; without this every "session-scoped" controller map in the runner was drain-scoped in
   * production. `drive-state-bridge.ts` is the other end.
   */
  readonly driveState: (
    op: SessionWorkerProtocol.DriveStateOp,
    args: ReadonlyArray<unknown>,
  ) => Promise<Extract<Reply, { readonly type: "drive-state-result" }>>
  /** Join a child session. BLOCKS host-side until completion or `timeoutMs` — see `AwaitChild`. */
  readonly awaitChild: (input: {
    readonly childID: string
    readonly timeoutMs: number
  }) => Promise<Extract<Reply, { readonly type: "await-child-result" }>>
  readonly execution: SessionExecutionAttempt.CurrentInterface
}

/** Worker-facing authority facade. Callers cannot choose another session identity; every request is
 * stamped from the host-issued lease before it reaches the correlated transport. */
export function make(input: { readonly lease: SessionExecutionAttempt.Lease; readonly client: Client }): Capabilities {
  let sequence = 0
  const identity = {
    version: SessionWorkerProtocol.VERSION,
    sessionID: input.lease.sessionID,
    attemptID: input.lease.attemptID,
    generation: input.lease.generation,
  }
  const requestID = () => `rpc_${input.lease.attemptID}_${++sequence}`
  const rejected = (reply: Reply) => {
    if (reply.type === "event-rejected" || reply.type === "device-rejected") throw new Error(reply.error)
    return reply
  }
  const execution = async (message: SessionWorkerProtocol.ExecutionRequest) => {
    const reply = await input.client.request(message)
    if (reply.type !== "execution-result") throw new Error(`unexpected ${reply.type} reply to execution request`)
    if (reply.outcome === "rejected") throw new Error(reply.error ?? "execution request rejected")
    return reply
  }

  return {
    publishEvent: async (eventType, data, metadata) => {
      const reply = rejected(
        await input.client.request({
          ...identity,
          type: "publish-event",
          requestID: requestID(),
          eventType,
          data,
          ...(metadata === undefined ? {} : { metadata }),
        }),
      )
      if (reply.type !== "event-published") throw new Error(`unexpected ${reply.type} reply to event publication`)
      return reply
    },
    admitDevice: async (request) => {
      const reply = rejected(
        await input.client.request({
          ...identity,
          type: "device-admit",
          requestID: requestID(),
          deviceKey: request.deviceKey,
          sessionClass: request.sessionClass,
          ...(request.priority === undefined ? {} : { priority: request.priority }),
          ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
          ...(request.locality === undefined ? {} : { locality: request.locality }),
        }),
      )
      if (reply.type !== "device-admitted") throw new Error(`unexpected ${reply.type} reply to device admission`)
    },
    releaseDevice: async (request) => {
      const reply = rejected(
        await input.client.request({
          ...identity,
          type: "device-release",
          requestID: requestID(),
          deviceKey: request.deviceKey,
        }),
      )
      if (reply.type !== "device-released") throw new Error(`unexpected ${reply.type} reply to device release`)
    },
    reportDevice: async (request) => {
      const reply = rejected(
        await input.client.request({
          ...identity,
          type: "device-report",
          requestID: requestID(),
          deviceKey: request.deviceKey,
          costTokens: request.costTokens,
        }),
      )
      if (reply.type !== "device-reported") throw new Error(`unexpected ${reply.type} reply to device report`)
    },
    admitMaintenance: async (request) => {
      const reply = rejected(
        await input.client.request({
          ...identity,
          type: "device-maintenance-admit",
          requestID: requestID(),
          deviceKey: request.deviceKey,
          task: request.task,
          ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
          ...(request.locality === undefined ? {} : { locality: request.locality }),
        }),
      )
      if (reply.type !== "device-maintenance-admitted")
        throw new Error(`unexpected ${reply.type} reply to maintenance admission`)
      return {
        maintenanceID: reply.maintenanceID,
        sessionID: reply.maintenanceID,
        deviceKey: request.deviceKey,
      }
    },
    releaseMaintenance: async (request) => {
      const reply = rejected(
        await input.client.request({
          ...identity,
          type: "device-maintenance-release",
          requestID: requestID(),
          deviceKey: request.deviceKey,
          maintenanceID: request.maintenanceID,
        }),
      )
      if (reply.type !== "device-maintenance-released")
        throw new Error(`unexpected ${reply.type} reply to maintenance release`)
    },
    awaitMaintenancePreemption: async (request) => {
      const reply = rejected(
        await input.client.request({
          ...identity,
          type: "device-maintenance-await-preemption",
          requestID: requestID(),
          deviceKey: request.deviceKey,
          maintenanceID: request.maintenanceID,
        }),
      )
      if (reply.type !== "device-maintenance-preempted")
        throw new Error(`unexpected ${reply.type} reply to maintenance preemption wait`)
    },
    assertPermission: async (request) => {
      const reply = await input.client.request({
        ...identity,
        type: "permission-assert",
        requestID: requestID(),
        input: { ...request, sessionID: input.lease.sessionID },
      })
      if (reply.type !== "permission-result") throw new Error(`unexpected ${reply.type} reply to permission assertion`)
      return reply
    },
    awaitChild: async (request) => {
      const reply = await input.client.request({
        ...identity,
        type: "await-child",
        requestID: requestID(),
        input: request as never,
      })
      if (reply.type !== "await-child-result") throw new Error(`unexpected ${reply.type} reply to await-child`)
      return reply
    },
    spawnChild: async (request) => {
      const reply = await input.client.request(
        // The identity spread carries the lease; the host reads parentID from it, never from here.
        { ...identity, type: "spawn-child", requestID: requestID(), input: request },
      )
      if (reply.type !== "spawn-result") throw new Error(`unexpected ${reply.type} reply to spawn`)
      return reply
    },
    memory: async (op, args) => {
      const reply = await input.client.request({
        ...identity,
        type: "memory-request",
        store: "kb",
        requestID: requestID(),
        op,
        args,
      })
      if (reply.type !== "memory-result") throw new Error(`unexpected ${reply.type} reply to memory-request`)
      return reply
    },
    worldMemory: async (op, args) => {
      const reply = await input.client.request({
        ...identity,
        type: "memory-request",
        store: "world",
        requestID: requestID(),
        op,
        args,
      })
      if (reply.type !== "memory-result") throw new Error(`unexpected ${reply.type} reply to world-memory-request`)
      return reply
    },
    localModel: async (op, args) => {
      const reply = await input.client.request({
        ...identity,
        type: "local-model-request",
        requestID: requestID(),
        op,
        args,
      })
      if (reply.type !== "local-model-result") throw new Error(`unexpected ${reply.type} reply to local-model-request`)
      return reply
    },
    driveState: async (op, args) => {
      const reply = await input.client.request({
        ...identity,
        type: "drive-state-request",
        requestID: requestID(),
        op,
        args,
      })
      if (reply.type !== "drive-state-result") throw new Error(`unexpected ${reply.type} reply to drive-state-request`)
      return reply
    },
    colleague: async (request) => {
      const reply = await input.client.request(
        // The identity spread carries the lease; the host reads the SENDER from it, never from here.
        { ...identity, type: "colleague-request", requestID: requestID(), input: request },
      )
      if (reply.type !== "colleague-result") throw new Error(`unexpected ${reply.type} reply to colleague-request`)
      return reply
    },
    execution: {
      fence: { attemptID: input.lease.attemptID, generation: input.lease.generation },
      advance: (phase, checkpoint) =>
        Effect.promise(() =>
          execution({ ...identity, type: "execution-advance", requestID: requestID(), phase, checkpoint }),
        ).pipe(Effect.asVoid),
      toolDispatched: (receipt) =>
        Effect.promise(() =>
          execution({ ...identity, type: "execution-tool-dispatched", requestID: requestID(), ...receipt }),
        ).pipe(Effect.asVoid),
      toolSettled: (callID) =>
        Effect.promise(() =>
          execution({ ...identity, type: "execution-tool-settled", requestID: requestID(), callID }),
        ).pipe(Effect.asVoid),
      providerStarted: (recovery) =>
        Effect.promise(() =>
          execution({
            ...identity,
            type: "execution-provider-started",
            requestID: requestID(),
            recovery: { ...recovery, startedAt: DateTime.toEpochMillis(recovery.startedAt) },
          }),
        ).pipe(Effect.asVoid),
      providerToolProtocol: () =>
        Effect.promise(() =>
          execution({ ...identity, type: "execution-provider-tool-protocol", requestID: requestID() }),
        ).pipe(Effect.asVoid),
      providerSettled: (providerAttemptID) =>
        Effect.promise(() =>
          execution({
            ...identity,
            type: "execution-provider-settled",
            requestID: requestID(),
            providerAttemptID,
          }),
        ).pipe(Effect.asVoid),
      servedBy: (fingerprint) =>
        Effect.promise(() =>
          execution({ ...identity, type: "execution-served-by", requestID: requestID(), fingerprint }),
        ).pipe(Effect.asVoid),
      providerRecovery: () =>
        Effect.promise(async () => {
          const reply = await execution({
            ...identity,
            type: "execution-provider-recovery",
            requestID: requestID(),
          })
          return reply.recovery
            ? SessionProviderRecovery.Info.make({
                ...reply.recovery,
                startedAt: DateTime.makeUnsafe(reply.recovery.startedAt),
              })
            : undefined
        }),
      contextUpdated: (update) =>
        Effect.promise(() =>
          execution({
            ...identity,
            type: "execution-context-updated",
            requestID: requestID(),
            messageID: update.messageID,
            timestamp: DateTime.toEpochMillis(update.timestamp),
            text: update.text,
            snapshot: update.snapshot,
          }),
        ).pipe(Effect.asVoid),
    },
  }
}
