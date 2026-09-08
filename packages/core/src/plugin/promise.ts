export * as PluginPromise from "./promise"

import { define, type Plugin as EffectPlugin } from "@novaclaw/plugin/v2/effect"
import type { Plugin, PluginContext, Registration } from "@novaclaw/plugin/v2/promise"
import { Effect, Scope } from "effect"

// The Effect host hands back this registration shape; mirror it structurally so
// we do not have to alias the Effect package's `Registration` against the Promise one.
type HostRegistration = { readonly dispose: Effect.Effect<void> }

/**
 * Adapts a Promise plugin into an Effect plugin so the existing Effect-only
 * loader (`PluginV2` / `PluginInternal`) can run it unchanged.
 *
 * Hook registrations created during the async `setup` attach to the plugin's
 * scope, so unloading the plugin disposes them. The captured fiber context
 * preserves boot-time batching, so Promise-plugin transforms still coalesce
 * into one reload per domain.
 */
export function fromPromise(plugin: Plugin): EffectPlugin {
  return define({
    id: plugin.id,
    effect: (host) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const context = yield* Effect.context<Scope.Scope>()

        // Run a hook registration on the plugin scope and resolve once it is registered.
        const register = (effect: Effect.Effect<HostRegistration, never, Scope.Scope>): Promise<Registration> =>
          Effect.runPromiseWith(context)(Scope.provide(scope)(effect)).then((registration) => ({
            dispose: () => Effect.runPromiseWith(context)(registration.dispose),
          }))

        const run = (effect: Effect.Effect<void>) => Effect.runPromiseWith(context)(effect)

        const transform =
          <Draft>(domain: {
            transform: (
              callback: (draft: Draft) => Effect.Effect<void> | void,
            ) => Effect.Effect<HostRegistration, never, Scope.Scope>
          }) =>
          (callback: (draft: Draft) => Promise<void> | void) =>
            register(domain.transform((draft) => Effect.promise(() => Promise.resolve(callback(draft)))))

        /**
         * The declarative bridge. It is deliberately the SHORTER of the two wrappers: a declaration
         * is data, so there is nothing to adapt between the promise and effect worlds except the
         * return. That asymmetry is the whole argument for `declare` in one line of code.
         */
        const declare =
          <Item>(domain: {
            declare: (items: readonly Item[]) => Effect.Effect<HostRegistration, never, Scope.Scope>
          }) =>
          (items: readonly Item[]) =>
            register(domain.declare(items))

        const context2: PluginContext = {
          options: host.options,
          agent: {
            declare: declare(host.agent),
            reload: () => run(host.agent.reload()),
          },
          app: {
            declare: (items) => register(host.app.declare(items)),
          },
          catalog: {
            declare: declare(host.catalog),
            reload: () => run(host.catalog.reload()),
          },
          command: {
            declare: declare(host.command),
            reload: () => run(host.command.reload()),
          },
          // The one CALLBACK bridge in this adapter — every other member is request/response.
          // `Effect.promise` turns a rejection into a defect, which the host's per-delivery
          // isolation catches and logs; the subscription survives it. The registration is
          // created on the plugin scope by `register`, so unloading the plugin ends it.
          event: {
            subscribe: (type, handler) =>
              register(host.event.subscribe(type, (event) => Effect.promise(() => handler(event)))),
          },
          integration: {
            transform: transform(host.integration),
            reload: () => run(host.integration.reload()),
            connection: {
              active: (id) => Effect.runPromiseWith(context)(host.integration.connection.active(id)),
              resolve: (connection) => Effect.runPromiseWith(context)(host.integration.connection.resolve(connection)),
            },
          },
          plugin: {
            add: (input) => {
              const child = fromPromise(input)
              return run(host.plugin.add(child))
            },
            remove: (id) => run(host.plugin.remove(id)),
          },
          reference: {
            declare: declare(host.reference),
            reload: () => run(host.reference.reload()),
          },
          skill: {
            declare: declare(host.skill),
            reload: () => run(host.skill.reload()),
          },
          tool: {
            register: (name, definition) => register(host.tool.register(name, definition)),
          },
        }

        yield* Effect.promise(() => Promise.resolve(plugin.setup(context2)))
      }),
  })
}
