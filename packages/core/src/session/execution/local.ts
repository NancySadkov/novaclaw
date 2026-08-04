import { Cause, Duration, Effect, Exit, Layer, Schedule } from "effect"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { Location } from "../../location"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { EventV2 } from "../../event"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionExecutionAttempt } from "../execution-attempt"

const HEARTBEAT_INTERVAL = Duration.seconds(5)
const STALE_AFTER_MS = 30_000

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const attempts = yield* SessionExecutionAttempt.Service
    const ownerID = `host_${crypto.randomUUID()}`
    // A prior host cannot clean up after its own death. Sweep after a grace window and keep sweeping:
    // a replacement may start before the dead host's last heartbeat is old enough to classify.
    yield* attempts
      .recoverStale(Date.now() - STALE_AFTER_MS)
      .pipe(Effect.repeat(Schedule.spaced(Duration.seconds(10))), Effect.forkScoped)
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const located = locations.get(session.location)
        // The drain IS a session's execution lifetime, so this is the single authoritative
        // seam for the `session.status` busy/idle vocabulary (the same truth /session/active
        // snapshots). Without it the app's optimistic submit-time "busy" was never cleared —
        // a session looked "working" forever after its first successful turn (stale folder-move
        // guard, stuck home spinners). Status is telemetry: publish failures never fail the run.
        // Stamp the location EXPLICITLY (the bridge's InstanceRef fallback is request-scoped and
        // absent on this coordinator fiber; an unstamped event loses its directory routing).
        const publishStatus = (status: SessionStatusEvent.Info) =>
          Location.Service.use((location) =>
            events.publish(
              SessionStatusEvent.Status,
              { sessionID, status },
              {
                location: new Location.Info({
                  directory: location.directory,
                  ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}),
                  root: location.root,
                  origin: location.origin,
                }),
              },
            ),
          ).pipe(Effect.provide(located), Effect.ignore)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* attempts.start(sessionID, ownerID)
            yield* publishStatus({ type: "busy" })
            yield* attempts
              .heartbeat(lease, "drain")
              .pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)), Effect.forkScoped)
            return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
              Effect.provideService(SessionExecutionAttempt.Current, {
                advance: (phase, checkpoint) => attempts.advance(lease, phase, checkpoint),
                toolDispatched: (receipt) => attempts.toolDispatched(lease, receipt),
                toolSettled: (callID) => attempts.toolSettled(lease, callID),
                providerStarted: (recovery) => attempts.providerStarted(lease, recovery),
                providerToolProtocol: () => attempts.providerToolProtocol(lease),
                providerSettled: (providerAttemptID) => attempts.providerSettled(lease, providerAttemptID),
                providerRecovery: () => attempts.providerRecovery(lease),
              }),
              Effect.provide(located),
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
              ),
              // `ensuring` so success, failure, AND interrupt (Stop) all settle back to idle —
              // except a session that called exit(result) mid-drain: `exited` is the K1 terminal
              // state and must not be stomped by a trailing idle.
              Effect.ensuring(
                Effect.gen(function* () {
                  const latest = yield* store.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
                  if (latest?.result !== undefined) return
                  yield* publishStatus({ type: "idle" })
                }),
              ),
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? attempts.settle(lease, "settled")
                  : Cause.hasInterrupts(exit.cause)
                    ? attempts.settle(lease, "interrupted", { classification: "interrupt" })
                    : attempts.settle(lease, "failed", {
                        classification: "runner-failure",
                        detail: Cause.pretty(exit.cause),
                      }),
              ),
            )
          }),
        )
      }),
    })

    const interruptBranch = (sessionID: SessionSchema.ID, visited: Set<SessionSchema.ID>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (visited.has(sessionID)) return
        visited.add(sessionID)
        // Stop the parent before discovering children. Taking the child snapshot first leaves a race
        // where an in-flight parent can spawn another worker after the snapshot and orphan it.
        yield* coordinator.interrupt(sessionID)
        const children = yield* store.children(sessionID)
        yield* Effect.forEach(children, (childID) => interruptBranch(childID, visited), {
          concurrency: "unbounded",
        })
      }).pipe(Effect.withSpan("SessionExecution.interruptBranch"))
    const interruptTree = (sessionID: SessionSchema.ID) => interruptBranch(sessionID, new Set())

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: interruptTree,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionExecutionAttempt.defaultLayer),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, SessionExecutionAttempt.node, LocationServiceMap.node, EventV2.node],
})

export * as SessionExecutionLocal from "./local"
