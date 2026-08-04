export * as SessionWorkerCapabilities from "./capabilities"

import type { PermissionV2 } from "@novaclaw/core/permission"
import type { QuestionV2 } from "@novaclaw/core/question"
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
    signal?: AbortSignal,
  ) => Promise<Extract<Reply, { readonly type: "event-published" }>>
  readonly admitDevice: (input: Omit<SessionScheduler.AdmitInput, "sessionID">, signal?: AbortSignal) => Promise<void>
  readonly releaseDevice: (
    input: Omit<SessionScheduler.ReleaseInput, "sessionID">,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly reportDevice: (input: Omit<SessionScheduler.ReportInput, "sessionID">, signal?: AbortSignal) => Promise<void>
  readonly assertPermission: (
    input: PermissionV2.AssertInput,
    signal?: AbortSignal,
  ) => Promise<Extract<Reply, { readonly type: "permission-result" }>>
  readonly askQuestion: (
    input: QuestionV2.AskInput,
    signal?: AbortSignal,
  ) => Promise<Extract<Reply, { readonly type: "question-result" }>>
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
  const execution = async (message: SessionWorkerProtocol.ExecutionRequest, signal?: AbortSignal) => {
    const reply = await input.client.request(message, signal)
    if (reply.type !== "execution-result") throw new Error(`unexpected ${reply.type} reply to execution request`)
    if (reply.outcome === "rejected") throw new Error(reply.error ?? "execution request rejected")
    return reply
  }

  return {
    publishEvent: async (eventType, data, metadata, signal) => {
      const reply = rejected(
        await input.client.request(
          {
            ...identity,
            type: "publish-event",
            requestID: requestID(),
            eventType,
            data,
            ...(metadata === undefined ? {} : { metadata }),
          },
          signal,
        ),
      )
      if (reply.type !== "event-published") throw new Error(`unexpected ${reply.type} reply to event publication`)
      return reply
    },
    admitDevice: async (request, signal) => {
      const reply = rejected(
        await input.client.request(
          {
            ...identity,
            type: "device-admit",
            requestID: requestID(),
            deviceKey: request.deviceKey,
            sessionClass: request.sessionClass,
            ...(request.priority === undefined ? {} : { priority: request.priority }),
          },
          signal,
        ),
      )
      if (reply.type !== "device-admitted") throw new Error(`unexpected ${reply.type} reply to device admission`)
    },
    releaseDevice: async (request, signal) => {
      const reply = rejected(
        await input.client.request(
          { ...identity, type: "device-release", requestID: requestID(), deviceKey: request.deviceKey },
          signal,
        ),
      )
      if (reply.type !== "device-released") throw new Error(`unexpected ${reply.type} reply to device release`)
    },
    reportDevice: async (request, signal) => {
      const reply = rejected(
        await input.client.request(
          {
            ...identity,
            type: "device-report",
            requestID: requestID(),
            deviceKey: request.deviceKey,
            costTokens: request.costTokens,
          },
          signal,
        ),
      )
      if (reply.type !== "device-reported") throw new Error(`unexpected ${reply.type} reply to device report`)
    },
    assertPermission: async (request, signal) => {
      const reply = await input.client.request(
        {
          ...identity,
          type: "permission-assert",
          requestID: requestID(),
          input: { ...request, sessionID: input.lease.sessionID },
        },
        signal,
      )
      if (reply.type !== "permission-result") throw new Error(`unexpected ${reply.type} reply to permission assertion`)
      return reply
    },
    askQuestion: async (request, signal) => {
      const reply = await input.client.request(
        {
          ...identity,
          type: "question-ask",
          requestID: requestID(),
          input: { ...request, sessionID: input.lease.sessionID },
        },
        signal,
      )
      if (reply.type !== "question-result") throw new Error(`unexpected ${reply.type} reply to question request`)
      return reply
    },
    execution: {
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
