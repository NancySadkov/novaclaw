export * as SessionExecutionWorker from "./execution"

import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { Log } from "@novaclaw/schema/log"
import { SessionPatch } from "@novaclaw/core/session/patch"
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
import * as SessionScratchFolder from "./scratch-folder"
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
import { SessionSpawner } from "@novaclaw/core/session/spawner"
import { SessionJoin } from "@novaclaw/core/session/join"
import { SessionLocationRecovery } from "@novaclaw/core/session/location-recovery"
import { SessionWorkerLocation } from "./location"

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

/**
 * Told to the USER, in the transcript, when a session's working folder has gone and it is now running
 * in a scratch folder.
 *
 * 🔴 **The `<env>` block tells the AGENT; this tells the person.** Context reports the new working
 * directory on the next turn, which is what the owner asked for and is enough for the model. But a
 * user reading the chat would otherwise see their working directory silently become
 * `…/scratch/ses_…` with nothing saying why — and the behaviour this REPLACED (isolating the session)
 * did explain itself. Degrading more gracefully must not mean explaining less.
 *
 * ⚠️ Names the missing folder, because "your folder is gone" is only actionable if the reader knows
 * WHICH one — a session may have been pointed somewhere they have forgotten about.
 */
export const folderSubstitutedNotice = (missing: string, scratch: string) =>
  `⚠️ This session's working folder is no longer there, so it is now running in a temporary scratch folder. ` +
  `Your work continues, but it is not where you left it: files this session creates land in the scratch folder ` +
  `until you point the session somewhere else.

Missing folder: ${missing}
Scratch folder: ${scratch}`

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
        const stored = yield* store.get(sessionID)
        if (!stored) return yield* Effect.die(`Session not found: ${sessionID}`)

        // 🔴 **Degrade, don't die: a session whose working folder has gone runs in a scratch folder.**
        // Before this the worker refused to start and the session was ISOLATED — legible but stopped,
        // waiting for a human. Worse, the prompt that triggered it was accepted with `200` and then
        // stranded `promoted_seq = NULL` with no `user` message ever written, so the user's words were
        // nowhere they could be seen. Recovering the session is what lets that input promote normally.
        //
        // ⚠️ The row is PATCHED rather than the directory being swapped locally, and that is load-
        // bearing in two ways. `runner/llm.ts` interrupts the turn when the session's stored directory
        // disagrees with the location it was handed, so a local-only swap would abandon every turn.
        // And the location GRAPH is keyed on the ref (`locations.get`), which is what
        // `system-context/builtins.ts` reads to build the `<env>` block — so patching is also what
        // makes the agent find out. That block is an Effect re-evaluated per turn precisely so
        // `SystemContext.reconcile` reports a change, which is the owner's requirement: the switch is
        // announced through the SAME channel that reports the working folder whenever it changes, not
        // a bespoke notice that would drift from it.
        const effective = SessionScratchFolder.workingDirectory(sessionID, stored.location.directory)
        if (effective !== stored.location.directory) {
          yield* Log.event("session.folder.substituted", {
            "session.id": sessionID,
            "session.folder.missing": stored.location.directory,
            "session.folder.scratch": effective,
          })
          // The person, not just the model — see `folderSubstitutedNotice`. Published BEFORE the patch
          // so it is stamped at the location the session is leaving, keeping the notice in the same
          // stream a reader is already following rather than arriving from a folder they have not
          // heard of yet.
          yield* events
            .publish(SessionEvent.Synthetic, {
              sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              text: folderSubstitutedNotice(stored.location.directory, effective),
            })
            .pipe(Effect.ignore)
          yield* SessionLocationRecovery.record(database.db, sessionID, stored.location.directory)
          yield* SessionPatch.patchSessionRecord(
            { db: database.db, events },
            sessionID,
            (info: SessionSchema.Info) => ({
              ...info,
              location: Location.Ref.make({
                directory: effective,
                ...(info.location.workspaceID ? { workspaceID: info.location.workspaceID } : {}),
              }),
            }),
          )
        }
        const session = effective === stored.location.directory ? stored : ((yield* store.get(sessionID)) ?? stored)

        const located = locations.get(session.location)
        // Location identity is DERIVED substrate state, including for the scratch fallback. Do not
        // fabricate a second identity here: a non-repository scratch folder resolves to origin
        // `global` and the path-root fallback, exactly like every other location. The old literal
        // (`origin: "server"`, `root: directory`) disagreed with Location.layer and made the same
        // session appear under two permission/event scopes depending on which side of the worker
        // boundary observed it.
        const location = yield* SessionWorkerLocation.resolve(located)
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
                    // Location-scoped, exactly like the two above — which is why spawn rides this
                    // channel rather than getting one of its own.
                    spawner: yield* SessionSpawner.Service,
                    // ⚠️ NOT `yield* SessionJoin.Service` — see join.ts. Resolving a service
                    // that is not already in the location graph inside this per-request
                    // handler abandons every tool-call turn. `events` is already built.
                    join: SessionJoin.fromEvents(events),
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
