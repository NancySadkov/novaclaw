export * as PluginV2 from "./plugin"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import type { HostPluginContext, Plugin as PluginRuntime } from "@novaclaw/plugin/v2/effect"

/**
 * The host runs every plugin against the FULL in-process context, first-party and external alike.
 *
 * ⚠️ The SDK's `Plugin["effect"]` is typed against the narrow external `PluginContext`, because that
 * is the contract a third party writes against. Here the parameter is the HOST view: an internal
 * plugin's effect legitimately asks for `transform`, and a function that demands more of its
 * argument cannot stand in for one that demands less. Narrowing this instead would have forced
 * first-party plugins to pretend they only ever declare.
 */
type HostEffect = (context: HostPluginContext) => ReturnType<PluginRuntime["effect"]>
import { Plugin } from "@novaclaw/schema/plugin"
import { AgentV2 } from "./agent"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { EventV2 } from "./event"
import { Integration } from "./integration"
import { KeyedMutex } from "./effect/keyed-mutex"
import { Location } from "./location"
import { PluginHost } from "./plugin/host"
import { Reference } from "./reference"
import { SkillV2 } from "./skill"
import { State } from "./state"
import { PluginTools } from "./tool/plugin-tools"

export const ID = Plugin.ID
export type ID = typeof ID.Type
export const Event = Plugin.Event

/**
 * What a loaded plugin says about itself, for the disclosure surface.
 *
 * `capabilities` is a CLAIM and never a grant — principle 13 is explicit that the plugin contract is
 * not a gate, because `import()` runs module scope before anything is validated. Its worth is 12(d):
 * a person can be shown what the code in their instance says it needs. `undefined` means the plugin
 * declared nothing, which is a different statement from declaring an empty set and is kept distinct
 * all the way to the screen.
 */
export interface Loaded {
  readonly id: ID
  readonly capabilities: readonly string[] | undefined
  /** `internal` for a plugin this build ships, `external` for one loaded from the config dir. */
  readonly source: "internal" | "external"
}

export interface Interface {
  readonly add: (
    id: ID,
    effect: HostEffect,
    declaration?: { readonly capabilities?: readonly string[]; readonly source?: "internal" | "external" },
  ) => Effect.Effect<void>
  readonly remove: (id: ID) => Effect.Effect<void>
  /** Every plugin currently loaded, with what it declared. Ordered by id so a render is stable. */
  readonly list: Effect.Effect<readonly Loaded[]>
  readonly wait: (id: ID) => Effect.Effect<void>
  /**
   * Resolves once the location's INITIAL plugin boot batch has completed — every built-in
   * plugin registered AND the deferred State.batch reloads materialized (catalog/agents/…
   * populated). `wait(id)` is NOT enough for that: it resolves inside the batch, before the
   * reloads run. Late/external plugin loads are not covered — this is the boot signal only.
   */
  readonly ready: Effect.Effect<void>
  /** Opens `ready`. Called by the plugin-internal boot after its initial batch. */
  readonly markReady: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Plugin") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const locks = KeyedMutex.makeUnsafe<ID>()
    const scope = yield* Scope.make()
    const active = new Map<ID, Scope.Closeable>()
    /** Kept beside `active` and cleared with it, so the list can never name a plugin that is gone. */
    const declared = new Map<ID, { capabilities: readonly string[] | undefined; source: "internal" | "external" }>()
    const loading = new Set<ID>()
    const waiters = new Map<ID, Set<Deferred.Deferred<void>>>()
    const failures = new Map<ID, Exit.Exit<void, never>>()
    const booted = yield* Deferred.make<void>()
    let host: HostPluginContext

    const add = Effect.fn("Plugin.add")(function* (
      id: ID,
      effect: HostEffect,
      declaration?: { readonly capabilities?: readonly string[]; readonly source?: "internal" | "external" },
    ) {
      if (loading.has(id)) return yield* Effect.die(`Plugin load cycle detected for ${id}`)

      yield* locks.withLock(id)(
        Effect.sync(() => {
          loading.add(id)
          failures.delete(id)
        }).pipe(
          Effect.andThen(
            State.batch(
              Effect.gen(function* () {
                const existing = active.get(id)
                active.delete(id)
                if (existing) yield* Scope.close(existing, Exit.void).pipe(Effect.ignore)

                const child = yield* Scope.fork(scope)
                yield* effect(host).pipe(
                  Scope.provide(child),
                  Effect.withSpan("Plugin.load", { attributes: { "plugin.id": id } }),
                  Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)),
                )
                yield* events.publish(Event.Added, { id })
                active.set(id, child)
                declared.set(id, {
                  capabilities: declaration?.capabilities,
                  source: declaration?.source ?? "internal",
                })
                yield* Effect.forEach(waiters.get(id) ?? [], (waiter) => Deferred.succeed(waiter, undefined), {
                  discard: true,
                })
                waiters.delete(id)
              }),
            ),
          ),
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void
            failures.set(id, exit)
            return Effect.forEach(waiters.get(id) ?? [], (waiter) => Deferred.done(waiter, exit), {
              discard: true,
            }).pipe(Effect.ensuring(Effect.sync(() => waiters.delete(id))))
          }),
          Effect.ensuring(Effect.sync(() => loading.delete(id))),
        ),
      )
    })

    const remove = Effect.fn("Plugin.remove")(function* (id: ID) {
      if (loading.has(id)) return yield* Effect.die(`Cannot remove plugin ${id} while it is loading`)

      yield* locks.withLock(id)(
        State.batch(
          Effect.gen(function* () {
            const current = active.get(id)
            active.delete(id)
            declared.delete(id)
            failures.delete(id)
            if (current) yield* Scope.close(current, Exit.void).pipe(Effect.ignore)
          }),
        ),
      )
    })

    const wait = Effect.fn("Plugin.wait")(function* (id: ID) {
      const waiter = yield* Deferred.make<void>()
      const pending = yield* locks.withLock(id)(
        Effect.sync(() => {
          if (active.has(id)) return false
          const failure = failures.get(id)
          if (failure) return failure
          const current = waiters.get(id) ?? new Set()
          current.add(waiter)
          waiters.set(id, current)
          return true
        }),
      )
      if (!pending) return
      if (typeof pending !== "boolean") return yield* pending
      yield* Deferred.await(waiter).pipe(
        Effect.ensuring(
          locks.withLock(id)(
            Effect.sync(() => {
              const current = waiters.get(id)
              current?.delete(waiter)
              if (current?.size === 0) waiters.delete(id)
            }),
          ),
        ),
      )
    })

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        active.clear()
        yield* State.batch(Scope.close(scope, exit))
      }),
    )

    const service = Service.of({
      add,
      remove,
      // Derived from `active` rather than kept as a third structure: a list that could disagree with
      // what is loaded is worse than none, and this file already keeps two maps in step.
      list: Effect.sync(() =>
        [...active.keys()].sort().map((id) => ({
          id,
          capabilities: declared.get(id)?.capabilities,
          source: declared.get(id)?.source ?? "internal",
        })),
      ),
      wait,
      ready: Deferred.await(booted),
      markReady: Deferred.succeed(booted, undefined).pipe(Effect.asVoid),
    })
    host = yield* PluginHost.make(service)
    return service
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(AgentV2.locationLayer),
  Layer.provideMerge(Catalog.locationLayer),
  Layer.provideMerge(CommandV2.locationLayer),
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Reference.locationLayer),
  Layer.provideMerge(SkillV2.locationLayer),
  Layer.provideMerge(PluginTools.layer),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    AgentV2.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    // The host scopes `ctx.event.subscribe` to THIS location (plus location-less globals), so
    // it needs to know which directory it is — see `plugin/host.ts`.
    Location.node,
    Reference.node,
    SkillV2.node,
    PluginTools.node,
  ],
})
