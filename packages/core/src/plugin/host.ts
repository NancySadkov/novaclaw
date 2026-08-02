export * as PluginHost from "./host"

import type { EventMap, EventType, PluginContext as Interface } from "@novaclaw/plugin/v2/effect"
import { EventManifest } from "@novaclaw/schema/event-manifest"
import { Log } from "@novaclaw/schema/log"
import { Cause, Effect, Queue, Schema, Scope, Stream } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { CommandV2 } from "../command"
import { Credential } from "../credential"
import { EventV2 } from "../event"
import { Integration } from "../integration"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"
import { Reference } from "../reference"
import type { DeepMutable } from "../schema"
import { SkillV2 } from "../skill"
import { PluginTools } from "../tool/plugin-tools"

const mutable = <T>(value: T) => value as DeepMutable<T>

/**
 * Per-subscription delivery buffer, in events.
 *
 * Back-pressure is not optional here: every typed PubSub in `EventV2` is `PubSub.unbounded`,
 * so an unbounded plugin subscription is a memory leak with a slow handler in it. This is the
 * same bound the HTTP event subscriber already uses (`packages/server/src/handlers/event.ts`,
 * `subscriberCapacity = 256`) and the shape of `EventV2.allBounded` — a `Queue.dropping`
 * installed at the publish seam.
 *
 * 256 is generous for what actually lands in one of these queues, because the filter runs
 * BEFORE the offer: a subscription buffers one event TYPE at one location, not the whole bus.
 * A handler that keeps up never drops; a wedged one costs a bounded 256 events and says so in
 * the log rather than dropping silently.
 */
const eventBufferCapacity = 256

/** The public/wire event shape (`/event`), which is what the SDK `Event` union describes. */
type PublicEvent = EventMap[EventType]

/**
 * Run ONE plugin's handler for ONE event with full isolation.
 *
 * A throw, a rejection or a defect is caught and logged, and — the point — the caller's loop
 * continues, so neither this plugin's next event nor any other plugin's subscription is
 * affected. (V1's event hook did `void hook(...)` inside `Effect.sync`: one synchronous throw
 * aborted the loop and every plugin registered after it missed that event.) Interrupts are
 * re-raised: teardown is not a handler failure. Same discipline as `EventV2`'s own `observe`.
 */
const isolate = (type: string, event: PublicEvent, handler: (event: PublicEvent) => Effect.Effect<void>) =>
  Effect.suspend(() => handler(event)).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Log.event("plugin.event.delivery.failed", {
          "plugin.event.type": type,
          "plugin.event.id": event.id,
          "plugin.cause": Cause.pretty(cause),
        }),
    ),
  )

/**
 * `ctx.event.subscribe` — the host side of the plugin event domain.
 *
 * Three things the host owns so no plugin author has to get them right:
 *  1. the fork and its teardown (the registration is scoped exactly like `tool.register`);
 *  2. per-delivery failure isolation (see `isolate`);
 *  3. a bounded, DROPPING buffer that logs what it drops.
 */
const subscribeEvents = Effect.fn("PluginHost.event.subscribe")(function* (
  events: EventV2.Interface,
  directory: string,
  type: string,
  handler: (event: PublicEvent) => Effect.Effect<void>,
) {
  // The public union carries one type the kernel bus never publishes
  // (`server.instance.disposed`, emitted by the instance supervisor on the process-global bus).
  // Registering silently would leave the plugin deaf with no way to find out — ruling 2: a
  // fault is never described falsely.
  if (EventManifest.Latest.get(type) === undefined) {
    yield* Log.event("plugin.event.subscription.unsupported", { "plugin.event.type": type })
  }

  const scope = yield* Scope.Scope
  const queue = yield* Queue.dropping<PublicEvent>(eventBufferCapacity)
  let active = true

  const unsubscribe = yield* events.listen((payload) => {
    // Total by construction: this runs INSIDE the publisher for non-durable events, where a
    // failing listener would fail the publish. Offer-to-a-dropping-queue and a log cannot fail.
    if (!active) return Effect.void
    if (payload.type !== type) return Effect.void
    // D3 — a plugin is a LOCATION node while the event bus is instance-global. Deliver this
    // location's events, plus events with NO location at all: those are genuinely global
    // (`models-dev.refreshed`, `catalog.updated` from a global service) and are nobody else's
    // data, so V1's `location?.directory !== ctx.directory` dropped them wrongly. Another
    // location's traffic never crosses.
    if (payload.location !== undefined && payload.location.directory !== directory) return Effect.void
    const event = { id: payload.id, type: payload.type, properties: payload.data } as PublicEvent
    return Queue.offer(queue, event).pipe(
      Effect.flatMap((accepted) =>
        accepted
          ? Effect.void
          : Log.event("plugin.event.dropped", {
              "plugin.event.type": type,
              "plugin.event.id": payload.id,
              "plugin.event.capacity": eventBufferCapacity,
            }),
      ),
    )
  })

  // Idempotent: serves both `dispose` and the scope finalizer. Unsubscribe FIRST so no offer
  // races the shutdown, then shut the queue — which ends the stream and retires the fiber.
  const stop = Effect.suspend(() => {
    if (!active) return Effect.void
    active = false
    return unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid)
  })

  yield* Stream.fromQueue(queue).pipe(
    Stream.runForEach((event) => isolate(type, event, handler)),
    // `isolate` already swallows per-delivery failure; this is the models-dev bug's antidote
    // (`Stream.runForEach |> forkScoped` with no `catchCause` there means a defect kills the
    // subscription and the plugin runs deaf forever). If anything still escapes, SAY SO.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Log.event("plugin.event.subscription.stopped", {
          "plugin.event.type": type,
          "plugin.cause": Cause.pretty(cause),
        }),
    ),
    Effect.forkIn(scope),
  )

  yield* Scope.addFinalizer(scope, stop)
  return { dispose: stop }
})

export const make = Effect.fn("PluginHost.make")(function* (plugin: PluginV2.Interface) {
  const agents = yield* AgentV2.Service
  const catalog = yield* Catalog.Service
  const commands = yield* CommandV2.Service
  const events = yield* EventV2.Service
  const integration = yield* Integration.Service
  const location = yield* Location.Service
  const reference = yield* Reference.Service
  const skill = yield* SkillV2.Service
  const pluginTools = yield* PluginTools.Service

  return {
    options: {},
    agent: {
      reload: agents.reload,
      transform: (callback) =>
        agents.transform((draft) =>
          callback({
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(AgentV2.ID.make(id))),
            default: (id) => draft.default(id === undefined ? undefined : AgentV2.ID.make(id)),
            update: (id, update) => draft.update(AgentV2.ID.make(id), update),
            remove: (id) => draft.remove(AgentV2.ID.make(id)),
          }),
        ),
    },
    catalog: {
      reload: catalog.reload,
      transform: (callback) =>
        catalog.transform((draft) =>
          callback({
            provider: {
              list: () => mutable(draft.provider.list()),
              get: (id) => mutable(draft.provider.get(ProviderV2.ID.make(id))),
              update: (id, update) => draft.provider.update(ProviderV2.ID.make(id), update),
              remove: (id) => draft.provider.remove(ProviderV2.ID.make(id)),
            },
            model: {
              get: (providerID, modelID) =>
                mutable(draft.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))),
              update: (providerID, modelID, update) =>
                draft.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID), update),
              remove: (providerID, modelID) =>
                draft.model.remove(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
              default: {
                get: draft.model.default.get,
                set: (providerID, modelID) =>
                  draft.model.default.set(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
              },
            },
          }),
        ),
    },
    command: {
      reload: commands.reload,
      transform: commands.transform,
    },
    event: {
      subscribe: (type, handler) =>
        // The handler is typed against ONE member of the map; the host loop is typed against
        // the union. Narrowing is guaranteed by the `payload.type !== type` filter, and is not
        // expressible to TypeScript through the erased generic — hence the one cast.
        subscribeEvents(events, location.directory, type, handler as (event: PublicEvent) => Effect.Effect<void>),
    },
    integration: {
      reload: integration.reload,
      connection: {
        active: (id) => integration.connection.active(Integration.ID.make(id)),
        resolve: (connection) =>
          integration.connection.resolve(
            connection.type === "credential" ? { ...connection, id: Credential.ID.make(connection.id) } : connection,
          ),
      },
      transform: (callback) =>
        integration.transform((draft) =>
          callback({
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(Integration.ID.make(id))),
            update: (id, update) => draft.update(Integration.ID.make(id), update),
            remove: (id) => draft.remove(Integration.ID.make(id)),
            method: {
              list: (id) => mutable(draft.method.list(Integration.ID.make(id))),
              update: (input) => {
                if ("authorize" in input) {
                  const methodID = Integration.MethodID.make(input.method.id)
                  const refresh = input.refresh
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { ...input.method, id: methodID },
                    authorize: (inputs) =>
                      input.authorize(inputs).pipe(
                        Effect.map((authorization) => {
                          if (authorization.mode === "auto") {
                            return {
                              ...authorization,
                              callback: authorization.callback.pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(credential.methodID),
                                  }),
                                ),
                              ),
                            }
                          }
                          return {
                            ...authorization,
                            callback: (code: string) =>
                              authorization.callback(code).pipe(
                                Effect.map((credential) =>
                                  Credential.OAuth.make({
                                    ...credential,
                                    methodID: Integration.MethodID.make(credential.methodID),
                                  }),
                                ),
                              ),
                          }
                        }),
                      ),
                    ...(refresh
                      ? {
                          refresh: (value: Credential.OAuth) =>
                            refresh(value).pipe(
                              Effect.map((next) =>
                                Credential.OAuth.make({
                                  ...next,
                                  methodID: Integration.MethodID.make(next.methodID),
                                }),
                              ),
                            ),
                        }
                      : {}),
                    ...(input.label ? { label: input.label } : {}),
                  })
                  return
                }
                if (input.method.type === "env") {
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { type: "env", names: input.method.names },
                  })
                  return
                }
                draft.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: { type: "key", label: input.method.label },
                })
              },
              remove: (id, method) =>
                draft.method.remove(Integration.ID.make(id), Schema.decodeUnknownSync(Integration.Method)(method)),
            },
          }),
        ),
    },
    plugin: {
      add: (input) => plugin.add(PluginV2.ID.make(input.id), input.effect),
      remove: (id) => plugin.remove(PluginV2.ID.make(id)),
    },
    reference: {
      reload: reference.reload,
      transform: (callback) =>
        reference.transform((draft) =>
          callback({
            add: (name, source) => draft.add(name, Schema.decodeUnknownSync(Reference.Source)(source)),
            remove: draft.remove,
            list: draft.list,
          }),
        ),
    },
    skill: {
      reload: skill.reload,
      transform: (callback) =>
        skill.transform((draft) =>
          callback({
            source: (source) => draft.source(Schema.decodeUnknownSync(SkillV2.Source)(source)),
            list: draft.list,
          }),
        ),
    },
    tool: {
      register: (name, definition) => pluginTools.register(name, definition),
    },
  } satisfies Interface
})
