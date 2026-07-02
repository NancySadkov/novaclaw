// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { createTranslator } from "@/event-v2-translate"
import { Context, Effect, Layer } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@novaclaw/EventV2Bridge") {}

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
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    // One V2->v1 legacy translator per sessionID. Each instance is a per-session
    // state machine (assistant identity, stable part ids, tool bookkeeping). We
    // never delete on step.ended (a tool-using turn emits N step.ended events
    // mid-turn; there is no per-turn terminal event to key cleanup on), so we
    // leave entries to accumulate -- session count is bounded in practice. The
    // F0 cutover can revisit eviction once turn-boundary semantics land.
    const translators = new Map<string, ReturnType<typeof createTranslator>>()

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        // ADDITIVE v1 projection: translate V2 session.next.* events into the
        // legacy v1 event vocabulary so unchanged desktop/CLI clients can render
        // V2 sessions. The startsWith guard keeps the legacy live path (flag OFF)
        // byte-identical -- this branch never runs for non-V2 events.
        const sessionID = (event.data as { sessionID?: unknown })?.sessionID
        if (event.type.startsWith("session.next.") && typeof sessionID === "string") {
          let translator = translators.get(sessionID)
          if (!translator) {
            translator = createTranslator()
            translators.set(sessionID, translator)
          }
          for (const envelope of translator.translate({
            type: event.type,
            data: event.data as Record<string, any>,
          })) {
            GlobalBus.emit("event", {
              directory: event.location?.directory ?? ctx?.directory,
              project: ctx?.project.id,
              workspace: workspaceID,
              payload: { type: envelope.type, properties: envelope.properties },
            })
          }
        }
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
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

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
