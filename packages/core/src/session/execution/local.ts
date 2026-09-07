import { Cause, Duration, Effect, Exit, Layer, Schedule } from "effect"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { Location } from "../../location"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { EventV2 } from "../../event"
import { SessionInterruptNotice } from "../interrupt-notice"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionExecutionAttempt } from "../execution-attempt"
import { Log } from "@novaclaw/schema/log"

const HEARTBEAT_INTERVAL = Duration.seconds(5)

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const attempts = yield* SessionExecutionAttempt.Service
    const ownerID = `host_${crypto.randomUUID()}`
    // ⚠️ The stale-lease sweep used to be forked HERE, and that is exactly why it never ran in
    // production: this layer has no production caller (the server binds `SessionExecutionWorker`
    // and a test pins that it does), so a dead host's leases were reclassified in tests only. It
    // now lives at the seam an instance adopts ANY executor — `session/boot-recovery.ts`, started
    // by `SessionV2`'s layer — and must not move back down into one implementation.
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
        const noteInterrupted = SessionInterruptNotice.publish({ events, store, sessionID, located })
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* attempts.start(sessionID, ownerID)
            yield* publishStatus({ type: "busy" })
            yield* attempts
              .heartbeat(lease, "drain")
              .pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)), Effect.forkScoped)
            const currentAttempt = {
              fence: { attemptID: lease.attemptID, generation: lease.generation },
              advance: (phase, checkpoint) => attempts.advance(lease, phase, checkpoint),
              toolDispatched: (receipt) => attempts.toolDispatched(lease, receipt),
              toolSettled: (callID) => attempts.toolSettled(lease, callID),
              providerStarted: (recovery) => attempts.providerStarted(lease, recovery),
              providerToolProtocol: () => attempts.providerToolProtocol(lease),
              providerSettled: (providerAttemptID) => attempts.providerSettled(lease, providerAttemptID),
              providerRecovery: () => attempts.providerRecovery(lease),
              servedBy: (fingerprint) => attempts.servedBy(lease, fingerprint),
            } satisfies SessionExecutionAttempt.CurrentInterface
            const runOnce = () =>
              SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
                Effect.provideService(SessionExecutionAttempt.Current, currentAttempt),
                Effect.provide(located),
                Effect.tapCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Log.event("session.drain.failed", { "session.id": sessionID, "session.cause": Log.fault(cause) }),
                ),
              )
            const drain: () => ReturnType<typeof runOnce> = () =>
              runOnce().pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? attempts
                        .settle(lease, "settled")
                        .pipe(
                          Effect.flatMap((settlement) =>
                            settlement === "recovery-pending"
                              ? Log.event("session.settlement.refused.recovery", { "session.id": sessionID }).pipe(
                                  Effect.andThen(drain()),
                                )
                              : Effect.void,
                          ),
                        )
                    : Cause.hasInterrupts(exit.cause)
                      ? // The ledger already recorded this (`state: "interrupted"`), and a ledger row
                        // is not a message — which is why the transcript showed the prompt and then
                        // nothing at all. `noteInterrupted` is the transcript's half.
                        SessionInterruptNotice.settleProvider({ events, attempts, lease, sessionID, located }).pipe(
                          Effect.andThen(attempts.settle(lease, "interrupted", { classification: "interrupt" })),
                          Effect.andThen(noteInterrupted),
                        )
                      : attempts.settle(lease, "failed", {
                          classification: "runner-failure",
                          detail: Cause.pretty(exit.cause),
                        }),
                ),
              )
            return yield* drain().pipe(
              // `ensuring` so success, failure, AND interrupt (Stop) all publish the status derived
              // from durable state. Reasserting `exited` is intentional: a tool-local terminal event
              // can be followed by live timing, and "skip idle" leaves that later `busy` uncorrected.
              Effect.ensuring(
                Effect.gen(function* () {
                  const latest = yield* store.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
                  yield* publishStatus({ type: latest?.result === undefined ? "idle" : "exited" })
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
