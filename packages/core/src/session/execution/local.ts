import { Cause, Effect, Layer } from "effect"
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

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
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
        yield* publishStatus({ type: "busy" })
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
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
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStore.defaultLayer))

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, EventV2.node],
})

export * as SessionExecutionLocal from "./local"
