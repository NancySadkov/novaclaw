export * as SessionExecutionWorker from "./execution"

import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { PermissionV2 } from "@novaclaw/core/permission"
import { QuestionV2 } from "@novaclaw/core/question"
import { SessionContextEpoch } from "@novaclaw/core/session/context-epoch"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionRunCoordinator } from "@novaclaw/core/session/run-coordinator"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import os from "node:os"
import { SessionWorkerCommand } from "./command"
import { SessionWorkerDeviceBridge } from "./device-bridge"
import { SessionWorkerEventBridge } from "./event-bridge"
import { SessionWorkerExecutionBridge } from "./execution-bridge"
import { SessionWorkerInteractionBridge } from "./interaction-bridge"
import * as SessionWorkerSupervisor from "./supervisor"

const failure = (outcome: SessionWorkerSupervisor.Outcome) =>
  outcome.type === "failed"
    ? `${outcome.classification}${outcome.detail ? `: ${outcome.detail}` : ""}`
    : outcome.type === "memory-limit"
      ? `session worker exceeded its memory limit (${Math.ceil(outcome.rssBytes / MIB)} MiB used; ${Math.ceil(outcome.limitBytes / MIB)} MiB allowed)`
      : `session worker ${outcome.type}${"detail" in outcome ? `: ${outcome.detail}` : ""}`

const MIB = 1024 * 1024
export const defaultMemoryLimitBytes = (totalBytes = os.totalmem()) =>
  Math.max(768 * MIB, Math.min(2_048 * MIB, Math.floor(totalBytes / 8)))

export const pausedNotice = (reason: "outcome-unknown" | "repeated-failure", detail: string) => {
  const guidance =
    reason === "outcome-unknown"
      ? "Nova did not replay the unfinished tool because its side effect may already have happened. Inspect the target, then explicitly retry if needed."
      : "Nova paused this session after repeated worker failures. You can retry, choose another model, or leave this chat stopped; other chats are unaffected."
  return `⚠️ This session was isolated after its worker stopped. ${guidance}\n\nTechnical detail: ${detail}`
}

/** Production session execution: the host owns admission, durable state and all privileged
 * capabilities; one disposable child owns one runner drain. Core's local layer remains the
 * explicit fallback for non-server embeddings and narrow tests. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const attempts = yield* SessionExecutionAttempt.Service
    const scheduler = yield* SessionScheduler.Service
    const database = yield* Database.Service
    const ownerID = `server_${crypto.randomUUID()}`
    const command = SessionWorkerCommand.current()

    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const located = locations.get(session.location)
        const location = new Location.Info({
          directory: session.location.directory,
          ...(session.location.workspaceID ? { workspaceID: session.location.workspaceID } : {}),
          root: session.location.directory,
          origin: "server",
        })
        const publishStatus = (status: SessionStatusEvent.Info) =>
          events.publish(SessionStatusEvent.Status, { sessionID, status }, { location }).pipe(Effect.ignore)
        yield* publishStatus({ type: "busy" })

        const runLocated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.runPromise(effect.pipe(Effect.provide(located)) as Effect.Effect<A, E>)
        const publishIdle = Effect.gen(function* () {
          const latest = yield* store.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
          if (latest?.result === undefined) yield* publishStatus({ type: "idle" })
        })

        for (;;) {
          const lease = yield* attempts.start(sessionID, ownerID)
          const workerInput: SessionWorkerSupervisor.Input = {
            command: command.command,
            env: command.env,
            lease,
            directory: session.location.directory,
            workspaceID: session.location.workspaceID,
            force,
            memoryLimitBytes: defaultMemoryLimitBytes(),
            onHeartbeat: (message) =>
              Effect.runPromise(SessionWorkerExecutionBridge.heartbeat({ attempts, lease, message })),
            onPublishEvent: (message) =>
              Effect.runPromise(SessionWorkerEventBridge.publish({ events, lease, location, message })),
            onDeviceRequest: (message) =>
              Effect.runPromise(SessionWorkerDeviceBridge.handle({ scheduler, lease, message })),
            onInteractionRequest: (message) =>
              runLocated(
                Effect.gen(function* () {
                  return yield* SessionWorkerInteractionBridge.handle({
                    permission: yield* PermissionV2.Service,
                    question: yield* QuestionV2.Service,
                    lease,
                    message,
                  })
                }),
              ),
            onExecutionRequest: (message) =>
              Effect.runPromise(
                SessionWorkerExecutionBridge.handle({
                  attempts,
                  lease,
                  message,
                  contextUpdated: (update) =>
                    SessionContextEpoch.publishUpdate(
                      database.db,
                      events,
                      { sessionID, messageID: update.messageID, timestamp: update.timestamp, text: update.text },
                      update.snapshot,
                    ),
                }),
              ),
            onExit: () => Effect.runPromise(SessionWorkerDeviceBridge.reclaim(scheduler, lease)),
          }
          const spawned = yield* Effect.try({
            try: () => SessionWorkerSupervisor.spawn(workerInput),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          }).pipe(Effect.exit)
          let outcome: SessionWorkerSupervisor.Outcome
          if (Exit.isFailure(spawned)) {
            const error = Cause.squash(spawned.cause)
            outcome = {
              type: "failed",
              classification: "worker-start",
              detail: error instanceof Error ? error.message : String(error),
            }
          } else {
            outcome = yield* Effect.promise(() => spawned.value.result).pipe(
              Effect.onInterrupt(() =>
                Effect.promise(() => spawned.value.interrupt()).pipe(
                  Effect.flatMap(() => attempts.settle(lease, "interrupted", { classification: "interrupt" })),
                  Effect.andThen(publishIdle),
                ),
              ),
            )
          }

          if (outcome.type === "settled") {
            yield* attempts.settle(lease, "settled")
            yield* publishIdle
            return
          }
          if (outcome.type === "interrupted") {
            yield* attempts.settle(lease, "interrupted", { classification: "interrupt" })
            yield* publishIdle
            return
          }

          const detail = failure(outcome)
          const decision = yield* attempts.recoverFailure(lease, {
            classification: outcome.type === "failed" ? outcome.classification : outcome.type,
            detail,
          })
          if (!decision?.automatic) {
            yield* events
              .publish(
                SessionEvent.Synthetic,
                {
                  sessionID,
                  messageID: SessionMessage.ID.create(),
                  timestamp: yield* DateTime.now,
                  text: pausedNotice(
                    decision?.reason === "outcome-unknown" ? "outcome-unknown" : "repeated-failure",
                    detail,
                  ),
                },
                { location },
              )
              .pipe(Effect.ignore)
            yield* publishIdle
            return yield* Effect.die(new Error(detail))
          }
          const info = yield* attempts.get(sessionID)
          yield* publishStatus({
            type: "retry",
            attempt: info?.failureCount ?? 1,
            next: 0,
            message:
              decision.action === "continue"
                ? "The session worker stopped after a safe checkpoint. Continuing in a fresh worker…"
                : decision.reason === "replay-safe-tool"
                  ? "The session worker stopped during a read-only tool. Retrying safely in a fresh worker…"
                  : "The session worker stopped before a side effect. Retrying in a fresh worker…",
          })
        }
      }),
    })

    const interruptBranch = (sessionID: SessionSchema.ID, visited: Set<SessionSchema.ID>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (visited.has(sessionID)) return
        visited.add(sessionID)
        yield* coordinator.interrupt(sessionID)
        const children = yield* store.children(sessionID)
        yield* Effect.forEach(children, (childID) => interruptBranch(childID, visited), { concurrency: "unbounded" })
      })

    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: (sessionID) => interruptBranch(sessionID, new Set()),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionExecutionAttempt.defaultLayer),
)
