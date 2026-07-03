// Novaclaw publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { Node } from "@novaclaw/core/effect/app-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@novaclaw/core/event"
import { PermissionV1 } from "@novaclaw/core/v1/permission"
import { Location } from "@novaclaw/core/location"
import { Project } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { createTranslator } from "@/event-v2-translate"
import { PermissionV2Project } from "@/permission/v2-project"
import { Context, Effect, Layer } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@novaclaw/EventV2Bridge") {}

// The bridge node is GLOBAL-tagged (F0): buildLocationServiceMap hoists global nodes out of the
// per-location Layer.fresh subtree, so the location graphs (MCP et al.) share the app graph's
// single bridge instance via the shared memoMap — exactly how EventV2.node itself stays a single
// bus. Before the tag, one fresh bridge (and listener) booted per location entry, and every
// translated legacy envelope was emitted once per instance: message.part.delta is append-only in
// the client reducer, so streamed text duplicated (N+1)x. The id-dedup below remains as
// belt-and-suspenders for the permission projection (it must publish exactly ONCE per source
// event even if an extra instance ever appears again).
const projectedPermissionEvents = new Set<string>()
const PROJECTED_CAP = 10_000
function shouldProject(id: string): boolean {
  if (projectedPermissionEvents.has(id)) return false
  if (projectedPermissionEvents.size >= PROJECTED_CAP) projectedPermissionEvents.clear()
  projectedPermissionEvents.add(id)
  return true
}

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
        // ADDITIVE v1 projection (1K): a V2-native session's permission ask must reach the
        // unchanged desktop/web/CLI clients, which only understand the legacy
        // "permission.asked" vocabulary. NB (corrected in F0): the web app consumes the GLOBAL
        // /global/event SSE (GlobalBus), not the per-instance /event EventV2 SSE — web, desktop
        // AND TUI all render through GlobalBus. Publishing the mapped V1 event back onto EventV2
        // (not just GlobalBus) still matters: this generic listener then mirrors it to GlobalBus,
        // and direct /event consumers (generated effect client) see it too. Field mapping:
        // action->permission, resources->patterns, save->always, source->tool — kept in sync with
        // the GET /permission bootstrap merge via PermissionV2Project (permission/v2-project.ts).
        // The reply travels back through the V1 reply route, which falls back to PermissionV2 when
        // the ask is pending there (handlers/permission.ts).
        // Re-entrancy is bounded: the projected V1 event matches neither branch below.
        if (event.type === "permission.v2.asked" && shouldProject(event.id)) {
          const request = event.data as PermissionV2Project.V2RequestLike
          yield* events.publish(
            PermissionV1.Event.Asked,
            PermissionV2Project.toV1Request(request) as unknown as typeof PermissionV1.Event.Asked.Type["data"],
            { location: event.location },
          )
        }
        if (event.type === "permission.v2.replied" && shouldProject(event.id)) {
          const replied = event.data as { sessionID: string; requestID: string; reply: string }
          yield* events.publish(
            PermissionV1.Event.Replied,
            {
              sessionID: replied.sessionID,
              requestID: replied.requestID,
              reply: replied.reply,
            } as unknown as typeof PermissionV1.Event.Replied.Type["data"],
            { location: event.location },
          )
        }
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

export const node = Node.makeGlobalNode({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
