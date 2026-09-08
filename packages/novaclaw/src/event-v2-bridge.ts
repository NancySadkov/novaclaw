// Novaclaw publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { Node } from "@novaclaw/core/effect/app-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Context, Effect, Layer } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@novaclaw/EventV2Bridge") {}

// The bridge node is GLOBAL-tagged (F0): buildLocationServiceMap hoists global nodes out of the
// per-location Layer.fresh subtree, so the location graphs (MCP et al.) share the app graph's
// single bridge instance via the shared memoMap — exactly how EventV2.node itself stays a single
// bus. Before the tag, one fresh bridge (and listener) booted per location entry, and every
// mirrored envelope was emitted once per instance (streamed deltas are append-only in the client
// fold, so duplicates corrupt text). NEVER re-untag this to per-location.

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            root: AbsolutePath.make(ctx.worktree),
            origin: ctx.origin,
          }),
        })
      })

    // S7: the V2→V1 projections are GONE. Every client (web/desktop stores, the CLI `run`
    // transport) consumes the RAW `session.next.*` / `permission.v2.*` events mirrored below —
    // there is no translated `message.*`/`permission.asked` vocabulary anymore. The raw mirror
    // and the durable `sync` envelope are the two emits that remain.
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.origin,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.origin,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data: event.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...events, publish })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer))

export const node = Node.makeGlobalNode({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
