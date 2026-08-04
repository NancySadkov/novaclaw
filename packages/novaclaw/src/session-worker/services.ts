export * as SessionWorkerServices from "./services"

import { Effect, Layer, Schema, Stream } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { PermissionV2 } from "@novaclaw/core/permission"
import { QuestionV2 } from "@novaclaw/core/question"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import type { SessionWorkerCapabilities } from "./capabilities"
import { makeGlobalNode, makeLocationNode } from "@novaclaw/core/effect/app-node"
import type { LayerNode } from "@novaclaw/core/effect/layer-node"

const unavailable = (operation: string) => new Error(`${operation} is host-only in a session worker`)
const hostEvents = new Set<string>(EventManifest.ServerDefinitions.map((definition) => definition.type))

/** Effect service implementations consumed by the real runner layer. Read/list/reply surfaces stay
 * host-only; only capabilities the draining worker legitimately needs cross the boundary. */
export function make(capabilities: SessionWorkerCapabilities.Capabilities): {
  readonly events: EventV2.Interface
  readonly permission: PermissionV2.Interface
  readonly question: QuestionV2.Interface
  readonly scheduler: SessionScheduler.Interface
} {
  const events: EventV2.Interface = {
    publish: (definition, data, options) => {
      if (options?.commit) return Effect.die(unavailable("event commit callback"))
      if (options?.id) return Effect.die(unavailable("caller-assigned event id"))
      // The worker runs the server's ordinary location layers, so boot and runner code may publish
      // catalog, filesystem, PTY, and session-record events as well as message events. Forward the
      // complete server manifest through the host-owned bus so ids, projections, and subscriptions
      // remain authoritative. Events that exist only in a UI/process-local manifest stay local.
      if (!hostEvents.has(definition.type)) {
        if (definition.durable) return Effect.die(unavailable(`durable ${definition.type} event publication`))
        return Effect.succeed({
          id: EventV2.ID.create(),
          type: definition.type,
          data,
          ...(options?.metadata === undefined ? {} : { metadata: options.metadata }),
        })
      }
      const encoded = Schema.encodeUnknownSync(definition.data)(data)
      return Effect.promise(() => capabilities.publishEvent(definition.type, encoded, options?.metadata)).pipe(
        Effect.map((published) => ({
          id: published.eventID,
          type: definition.type,
          data,
          ...(published.durable === undefined ? {} : { durable: published.durable }),
        })),
      )
    },
    subscribe: () => Stream.die(unavailable("event subscription")),
    all: () => Stream.die(unavailable("event stream")),
    durable: () => Stream.die(unavailable("durable event stream")),
    // Plugins are materialized in the worker so their registered tools can execute there, but their
    // event reactions belong to the host's long-lived location service. Registering the same
    // listener in a one-drain worker would duplicate reactions and it has no inbound event stream;
    // accept registration as an inert subscription with an idempotent unsubscribe.
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.die(unavailable("event projector")),
    replay: () => Effect.die(unavailable("event replay")),
    replayAll: () => Effect.die(unavailable("event replay")),
    remove: () => Effect.die(unavailable("event removal")),
    claim: () => Effect.die(unavailable("event ownership claim")),
  }

  const assertPermission = (
    request: PermissionV2.AssertInput,
  ): Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError> =>
    Effect.tryPromise({
      try: () => capabilities.assertPermission(request),
      catch: () => new PermissionV2.RejectedError(),
    }).pipe(
      Effect.flatMap((result): Effect.Effect<void, PermissionV2.Error | SessionV2.NotFoundError> => {
        switch (result.outcome) {
          case "allowed":
            return Effect.void
          case "denied":
            return Effect.fail(
              new PermissionV2.DeniedError({
                rules: result.rules ?? [],
                ...(Schema.is(PermissionV2.DenialReason)(result.reason) ? { reason: result.reason } : {}),
              }),
            )
          case "corrected":
            return Effect.fail(new PermissionV2.CorrectedError({ feedback: result.feedback ?? "Action declined" }))
          case "session-missing":
            return Effect.fail(new SessionV2.NotFoundError({ sessionID: request.sessionID }))
          case "rejected":
            return Effect.fail(new PermissionV2.RejectedError())
        }
      }),
    )

  const permission: PermissionV2.Interface = {
    ask: () => Effect.die(unavailable("permission request inspection")),
    assert: assertPermission,
    reply: () => Effect.die(unavailable("permission reply")),
    get: () => Effect.die(unavailable("permission request lookup")),
    forSession: () => Effect.die(unavailable("permission request listing")),
    list: () => Effect.die(unavailable("permission request listing")),
  }

  const question: QuestionV2.Interface = {
    ask: (request) =>
      Effect.promise(() => capabilities.askQuestion(request)).pipe(
        Effect.flatMap((result) =>
          result.outcome === "answered"
            ? Effect.succeed(result.answers ?? [])
            : Effect.fail(new QuestionV2.RejectedError()),
        ),
      ),
    reply: () => Effect.die(unavailable("question reply")),
    reject: () => Effect.die(unavailable("question rejection")),
    list: () => Effect.die(unavailable("question listing")),
  }

  const scheduler: SessionScheduler.Interface = {
    admit: (request) => Effect.promise(() => capabilities.admitDevice(request)).pipe(Effect.asVoid),
    release: (request) => Effect.promise(() => capabilities.releaseDevice(request)).pipe(Effect.asVoid),
    report: (request) => Effect.promise(() => capabilities.reportDevice(request)).pipe(Effect.asVoid),
    evict: () => Effect.die(unavailable("scheduler eviction")),
    snapshot: () => Effect.die(unavailable("scheduler snapshot")),
  }

  return { events, permission, question, scheduler }
}

export function replacements(capabilities: SessionWorkerCapabilities.Capabilities): LayerNode.Replacements {
  const services = make(capabilities)
  return [
    [
      EventV2.node,
      makeGlobalNode({ service: EventV2.Service, layer: Layer.succeed(EventV2.Service, services.events), deps: [] }),
    ],
    [
      PermissionV2.node,
      makeLocationNode({
        service: PermissionV2.Service,
        layer: Layer.succeed(PermissionV2.Service, services.permission),
        deps: [],
      }),
    ],
    [
      QuestionV2.node,
      makeLocationNode({
        service: QuestionV2.Service,
        layer: Layer.succeed(QuestionV2.Service, services.question),
        deps: [],
      }),
    ],
    [
      SessionScheduler.node,
      makeGlobalNode({
        service: SessionScheduler.Service,
        layer: Layer.succeed(SessionScheduler.Service, services.scheduler),
        deps: [],
      }),
    ],
  ]
}
