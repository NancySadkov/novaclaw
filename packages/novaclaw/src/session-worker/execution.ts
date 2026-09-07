export * as SessionExecutionWorker from "./execution"

import { Cause, DateTime, Effect, Exit, Layer } from "effect"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { Database } from "@novaclaw/core/database/database"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { EventV2 } from "@novaclaw/core/event"
import { Log } from "@novaclaw/schema/log"
import { SessionPatch } from "@novaclaw/core/session/patch"
import { Location } from "@novaclaw/core/location"
import { AgentRetire } from "@novaclaw/core/agent/retire"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { PermissionV2 } from "@novaclaw/core/permission"
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
import { SessionInterruptNotice } from "@novaclaw/core/session/interrupt-notice"
import { SessionStore } from "@novaclaw/core/session/store"
import os from "node:os"
import { SessionWorkerCommand } from "./command"
import { SessionWorkerAdmission } from "./admission"
import { SessionWorkerDeviceBridge } from "./device-bridge"
import { SessionWorkerEventBridge } from "./event-bridge"
import { SessionWorkerExecutionBridge } from "./execution-bridge"
import { SessionWorkerInteractionBridge } from "./interaction-bridge"
import { SessionWorkerMemoryBridge } from "./memory-bridge"
import { SessionWorkerLocalModelBridge } from "./local-model-bridge"
import { SessionWorkerDriveStateBridge } from "./drive-state-bridge"
import { SessionDriveState } from "@novaclaw/core/session/runner/drive-state"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { LocalModelRuntime } from "@/local-model/runtime"
import * as SessionWorkerSupervisor from "./supervisor"
import { SessionSpawner } from "@novaclaw/core/session/spawner"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { SessionJoin } from "@novaclaw/core/session/join"
import { SessionLocationRecovery } from "@novaclaw/core/session/location-recovery"
import { SessionWorkerLocation } from "./location"
import { WorkerRegistry } from "@/storage/worker-registry"

/**
 * Render ONE worker outcome as the sentence a person reads under *"Technical detail:"*.
 *
 * 🔴 **Exhaustive over `Outcome` on purpose — the catch-all arm is what threw the evidence away.**
 * This used to end in `` `session worker ${outcome.type}${"detail" in outcome ? … }` ``, which is a
 * default arm wearing a renderer's clothes: `exited` carries a `code` and `signaled` carries a
 * `signal`, neither of them under the key `detail`, so both variants were captured by the supervisor
 * off the child's real `exit` event and then dropped here. Every crash — an uncaught throw, a module
 * missing from a packaged build, an OS OOM kill — reached the transcript as the same five words, and
 * a fault described identically to every other fault is a fault described falsely (ruling 2).
 *
 * ⚠️ **`satisfies never` in the default arm is the door this closes**, not a stylistic preference. A
 * catch-all renders a variant nobody has written a sentence for, silently and forever; this makes a
 * new `Outcome` member a COMPILE error until someone says what it should say. That is the same device
 * `memory-bridge.ts` uses over `MEMORY_OPS`, and it is the only rung above "we remembered".
 */
export const failureDetail = (outcome: SessionWorkerSupervisor.Outcome): string => {
  switch (outcome.type) {
    case "failed":
      return `${outcome.classification}${outcome.detail ? `: ${outcome.detail}` : ""}`
    case "memory-limit":
      return `session worker exceeded its memory limit (${Math.ceil(outcome.rssBytes / MIB)} MiB used; ${Math.ceil(outcome.limitBytes / MIB)} MiB allowed)`
    case "protocol-error":
      return `session worker protocol error: ${outcome.detail}`
    // The two the supervisor learns from the child's own `exit` event. Naming the code or the signal
    // is the whole point: it is what separates "it threw" from "the OS killed it" in a bug report.
    case "exited":
      return `session worker exited with code ${outcome.code}`
    case "signaled":
      return `session worker was killed by signal ${outcome.signal}`
    case "start-timeout":
      return "session worker did not report ready before its startup deadline"
    case "heartbeat-timeout":
      return "session worker stopped sending heartbeats"
    case "stale-message":
      return "session worker sent a message for a superseded execution"
    // Neither of these two reaches a failure notice — the caller returns on both before rendering —
    // but a total renderer has to answer for them, and answering with the bare tag is the habit that
    // lost the code and the signal in the first place.
    case "interrupted":
      return "session worker was interrupted"
    case "settled":
      return "session worker finished its drain"
    default:
      return `session worker ${outcome satisfies never}`
  }
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB
export const defaultMemoryLimitBytes = (totalBytes = os.totalmem()) =>
  Math.max(768 * MIB, Math.min(2 * GIB, Math.floor(totalBytes / 8)))

/** Source-mode Bun carries the TypeScript compiler/module graph in every worker. Its measured healthy
 * RSS is 2.62 GB on Windows, above the 2 GiB packaged-Node containment cap before user work grows at
 * all. Keep the production artifact bounded at the measured tier ceiling; give only the explicit `.ts`
 * developer/test entrypoint enough room to boot and complete a turn. */
export const workerMemoryLimitBytes = (workerPath: string, totalBytes = os.totalmem()) =>
  workerPath.endsWith(".ts")
    ? Math.max(defaultMemoryLimitBytes(totalBytes), 3 * GIB)
    : defaultMemoryLimitBytes(totalBytes)

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
    // Staffing the roster is a HOST act (see the hand-off below): the store is the durable truth and
    // the live roster is this process's snapshot, so both are resolved here, once, at layer build —
    // never inside the per-request handler, which is the trap `SessionJoin` warns about above.
    const agentConfig = yield* AgentConfigStore.Service
    // Retiring a colleague clears its cabinet, so this seam needs a memory client too. Resolved at
    // layer build like everything else here — `Memory.client` wraps a CAPABILITY that acquires per
    // call, so holding it costs nothing when memory is disabled and never blocks the handler.
    const memory = Memory.client(yield* Memory.node.service)
    const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
    // The ONE managed local-model runtime. A worker's `LocalModelManager.node` is replaced by an RPC
    // client that lands here, so `ensure` in a turn starts (or finds) the host's llama.cpp child
    // instead of a second one on the same port. Resolved at layer build like memory, and for the
    // same reason: it is a global, one per instance, never one per folder.
    const localModels = yield* LocalModelManager.Service
    // The runner's cross-drain facts. THIS process outlives a drain, so the store is here; a worker
    // reaches it by RPC and the drain below pins the session for the worker's whole life.
    const driveState = yield* SessionDriveState.Service
    const ownerID = `server_${crypto.randomUUID()}`
    const command = SessionWorkerCommand.current()
    // Process admission is deliberately OUTSIDE the worker. A child queued here consumes durable
    // session state and no resident process; once admitted, the permit covers the worker's complete
    // drain and is released on success, failure, or interruption by `workerAdmission.run`.
    const workerAdmission = yield* SessionWorkerAdmission.make()

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

        return yield* workerAdmission.run(
          {
            sessionID: String(sessionID),
            priority: SessionScheduler.isInteractive(SessionScheduler.classForSessionType(session.type))
              ? "interactive"
              : "batch",
          },
          Effect.gen(function* () {
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

            const runLocated = <A, E, R>(effect: Effect.Effect<A, E, R>, signal: AbortSignal) =>
              Effect.runPromise(effect.pipe(Effect.provide(located)) as Effect.Effect<A, E>, { signal })
            // The transcript's half of an interruption. The ledger records the interrupt either way;
            // a ledger row is not a message, so without this a turn stopped before it replied left the
            // prompt with nothing after it. Shared with the in-process executor because THIS is the
            // layer the server binds — a fix that lives only in `execution/local.ts` never runs.
            const noteInterrupted = SessionInterruptNotice.publish({ events, store, sessionID, located })
            // `idle` is the scheduler axis only: it means this session is no longer consuming a worker.
            // The attempt row is updated BEFORE every call below and owns whether the stop was settled,
            // interrupted, failed or paused. UI attention must join both facts; treating idle alone as
            // success is how an exhausted recovery used to disappear behind a healthy-looking roster.
            const publishSettledStatus = Effect.gen(function* () {
              const latest = yield* store.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
              yield* publishStatus({ type: latest?.result === undefined ? "idle" : "exited" })
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
                memoryLimitBytes: workerMemoryLimitBytes(command.workerPath),
                // Every host Effect is tied to this worker's lifetime. Once supervision stops the
                // child, an outstanding admission or publication must unwind before deletion can
                // continue; it may never finish later against state the worker no longer owns.
                onHeartbeat: (message, signal) =>
                  Effect.runPromise(SessionWorkerExecutionBridge.heartbeat({ attempts, lease, message }), { signal }),
                onPublishEvent: (message, signal) =>
                  Effect.runPromise(SessionWorkerEventBridge.publish({ events, attempts, lease, location, message }), {
                    signal,
                  }),
                onDeviceRequest: (message, signal) =>
                  Effect.runPromise(SessionWorkerDeviceBridge.handle({ scheduler, lease, message }), { signal }),
                onInteractionRequest: (message, signal) =>
                  runLocated(
                    Effect.gen(function* () {
                      // ⚠️ Resolved HERE, like `spawner` below and unlike `join`: `AgentV2` IS a
                      // location node, so this is the ordinary path rather than the per-request trap.
                      // The distinction the warning draws is "already in the location graph", not
                      // "resolved inside the handler".
                      const roster = yield* AgentV2.Service
                      return yield* SessionWorkerInteractionBridge.handle({
                        permission: yield* PermissionV2.Service,
                        // Location-scoped, exactly like the two above — which is why spawn rides this
                        // channel rather than getting one of its own.
                        spawner: yield* SessionSpawner.Service,
                        // ⚠️ NOT `yield* SessionJoin.Service` — see join.ts. Resolving a service
                        // that is not already in the location graph inside this per-request
                        // handler abandons every tool-call turn. `events` is already built.
                        join: SessionJoin.fromParts({
                          events,
                          session: (id) => store.get(id),
                          sequence: (id) => EventV2.latestSequence(database.db, id),
                        }),
                        // ⚠️ Built from parts, NOT `yield* ColleagueHandoff.Service` — the same trap the
                        // line above names for `SessionJoin`: resolving a service that is not already in
                        // the location graph inside this per-request handler abandons the tool-call turn.
                        // Measured: the first live hand-off left the sender's call `running` forever with
                        // nothing in the log.
                        colleague: ColleagueHandoff.fromParts({
                          db: database.db,
                          events,
                          session: (id) => store.get(id),
                          // Staffing runs here too, and must: a hire written from inside the worker
                          // reloads the WORKER's roster, leaving the colleague durable and invisible to
                          // the instance — measured 2026-08-21, `Procius` was in the store and absent
                          // from `GET /api/agent`.
                          store: agentConfig,
                          refresh: roster.reload(),
                          roster: roster.all(),
                          takenNames: roster
                            .all()
                            .pipe(Effect.map((all) => all.flatMap((one) => [String(one.id), one.name ?? ""]))),
                          // `true` is honest on THIS path and is not a guess: the coordinator either
                          // starts a drain for that session or marks a pending wake on the one already
                          // running, so the receiver's turn happens either way. The relay's own `wake`
                          // returns false only when no executor is attached at all, which cannot be the
                          // case inside a live worker host.
                          wake: (id) => coordinator.wake(id).pipe(Effect.as(true)),
                          forget: (colleague) =>
                            AgentRetire.everything({
                              db: database.db,
                              events,
                              memory,
                              worldMemory,
                              agent: colleague,
                              at: Date.now(),
                            }),
                        }),
                        lease,
                        message,
                      })
                    }),
                    signal,
                  ),
                /**
                 * 🔴 The host's engine is THE engine. `memory` above is the client this layer resolved
                 * once at build; the worker's `Memory.node` replacement turns every op inside the turn
                 * into one of these, so there is exactly one WASM store on the graph directory.
                 *
                 * ⚠️ NOT inside `runLocated`, unlike the interaction bridge — `MemoryClient` is a GLOBAL
                 * node, and resolving it per request would be the trap `SessionJoin` names above. It is
                 * also why this needs no location: the graph is one per instance, never one per folder.
                 */
                onMemoryRequest: (message, signal) =>
                  Effect.runPromise(SessionWorkerMemoryBridge.handle({ memory, lease, message }), { signal }),
                // Keep the lifetime signal visibly at this handler seam; the structural test counts
                // these explicit bindings so a new bridge cannot silently become uninterruptible.
                // prettier-ignore
                onWorldMemoryRequest: (message, signal) =>
                  Effect.runPromise(SessionWorkerMemoryBridge.handle({ memory: worldMemory, lease, message }), { signal }),
                onLocalModelRequest: (message, signal) =>
                  Effect.runPromise(SessionWorkerLocalModelBridge.handle({ manager: localModels, lease, message }), {
                    signal,
                  }),
                onDriveStateRequest: (message, signal) =>
                  Effect.runPromise(SessionWorkerDriveStateBridge.handle({ store: driveState, lease, message }), {
                    signal,
                  }),
                onExecutionRequest: (message, signal) =>
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
                    { signal },
                  ),
                // The drain is over: release the drive-state pin taken below, after the device
                // reclaim, so a session is swept only once nothing of its run is still live.
                onExit: () =>
                  Effect.runPromise(
                    SessionWorkerDeviceBridge.reclaim(scheduler, lease).pipe(
                      Effect.ensuring(driveState.unpin(sessionID)),
                    ),
                  ),
              }
              // Pin the session's drive state for the worker's whole life; `onExit` releases it.
              yield* driveState.pin(sessionID)
              const spawned = yield* Effect.try({
                try: () => SessionWorkerSupervisor.spawn(workerInput),
                catch: (error) => (error instanceof Error ? error : new Error(String(error))),
              }).pipe(Effect.exit)
              // A spawn that never produced a worker never runs `onExit`: release the pin here.
              if (Exit.isFailure(spawned)) yield* driveState.unpin(sessionID)
              let outcome: SessionWorkerSupervisor.Outcome
              if (Exit.isFailure(spawned)) {
                const error = Cause.squash(spawned.cause)
                outcome = {
                  type: "failed",
                  classification: "worker-start",
                  detail: error instanceof Error ? error.message : String(error),
                }
              } else {
                // 🔴 The instance's ONLY fleet view. Without it every memory bound stays per-worker, and
                // N workers each within their own limit can exhaust the host with nobody able to see it.
                // Released on EVERY exit — success, failure and interrupt — via `ensuring` below, because
                // a registry that leaks entries names pids the OS may have handed to somebody else.
                const releaseWorker = WorkerRegistry.register({
                  pid: spawned.value.pid,
                  sessionID: String(sessionID),
                  at: Date.now(),
                })
                outcome = yield* Effect.promise(() => spawned.value.result).pipe(
                  Effect.ensuring(Effect.sync(releaseWorker)),
                  Effect.onInterrupt(() =>
                    Effect.promise(() => spawned.value.interrupt()).pipe(
                      Effect.andThen(
                        SessionInterruptNotice.settleProvider({ events, attempts, lease, sessionID, located }),
                      ),
                      Effect.flatMap(() => attempts.settle(lease, "interrupted", { classification: "interrupt" })),
                      Effect.andThen(noteInterrupted),
                      Effect.andThen(publishSettledStatus),
                    ),
                  ),
                )
              }

              if (outcome.type === "settled") {
                const settlement = yield* attempts.settle(lease, "settled")
                if (settlement === "recovery-pending") {
                  yield* Log.event("session.settlement.refused.recovery", { "session.id": sessionID })
                  // Settlement is a compare-and-transition operation: a durable provider obligation
                  // makes success illegal. Start a replacement generation immediately and let the
                  // runner consume that obligation; never expose a false idle boundary to the UI.
                  continue
                }
                if (settlement === "superseded") return
                yield* publishSettledStatus
                return
              }
              if (outcome.type === "interrupted") {
                yield* SessionInterruptNotice.settleProvider({ events, attempts, lease, sessionID, located })
                yield* attempts.settle(lease, "interrupted", { classification: "interrupt" })
                yield* noteInterrupted
                yield* publishSettledStatus
                return
              }

              const detail = failureDetail(outcome)
              // `attempts.start` necessarily replaces the single current-attempt row on the next
              // loop. Record the terminal evidence before that happens; otherwise a successful
              // recovery erases the classification needed to diagnose a repeatable worker loss.
              yield* Log.event("session.drain.failed", {
                "session.id": sessionID,
                "session.cause": Log.fault(detail),
              })
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
                yield* publishSettledStatus
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
        )
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

/** The server graph's concrete binding for core's deliberately-unbound execution service. */
export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [
    SessionStore.node,
    LocationServiceMap.node,
    EventV2.node,
    SessionExecutionAttempt.node,
    SessionScheduler.node,
    Database.node,
    AgentConfigStore.node,
    Memory.node,
    WorldMemory.node,
    // The manager the server graph builds, named here so this layer resolves the runtime client and
    // never core's inert default (whose `ensure` is a no-op that would leave every worker modelless).
    LocalModelRuntime.managerNode,
    SessionDriveState.node,
  ],
})
