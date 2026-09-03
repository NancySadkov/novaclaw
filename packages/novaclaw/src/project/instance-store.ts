import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceEvent } from "@novaclaw/schema/instance-event"
import { serviceUse } from "@novaclaw/core/effect/service-use"
import { InstanceRef } from "@/effect/instance-ref"
import { describeDisposeFailures, disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import { InstanceBootstrap as InstanceBootstrapGraph } from "./bootstrap"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Log } from "@novaclaw/schema/log"

export interface LoadInput {
  directory: string
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

export const layer: Layer.Layer<Service, never, ProjectV2.Service | InstanceBootstrap.Service | EventV2Bridge.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* ProjectV2.Service
      const bootstrap = yield* InstanceBootstrap.Service
      const bus = yield* EventV2Bridge.Service
      const scope = yield* Scope.Scope
      const cache = new Map<string, Entry>()

      const boot = (input: LoadInput & { directory: string }) =>
        Effect.gen(function* () {
          const resolved = yield* project.resolve(AbsolutePath.make(FSUtil.resolve(input.directory)))
          const ctx: InstanceContext = {
            directory: input.directory,
            // Outside any repo the boundary sentinel stays "/" — never a filesystem root that would
            // contains-match the whole drive.
            //
            // ⚠️ THIS VALUE IS DECODED IN THREE PLACES, and each one had to learn it separately:
            // `containsPath` skips the worktree check for it, `Config.writableConfigDir` refuses it
            // as a write root, and `FSUtil.walkBoundary` turns it into the home floor rather than a
            // walk to the drive root. Every consumer that reads it as an ORDINARY path silently
            // widens to the whole volume — that is what it did to the config and skill walks — so a
            // new consumer of `worktree` states what it does with the sentinel or it has a bug.
            worktree: resolved.vcs ? resolved.directory : "/",
            origin: resolved.id,
            ...(resolved.vcs ? { vcs: resolved.vcs.type } : {}),
          }
          yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
          return ctx
        }).pipe(Effect.withSpan("InstanceStore.boot"))

      const removeEntry = (directory: string, entry: Entry) =>
        Effect.sync(() => {
          if (cache.get(directory) !== entry) return false
          cache.delete(directory)
          return true
        })

      const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(boot({ ...input, directory }))
          if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
          yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
        })

      /**
       * ONE producer, two surfaces. The publish goes on the bus, where `/api/event` serves it — the
       * contract stream the CLI reads since the legacy `/event` left (2026-09-03) — and
       * `EventV2Bridge` mirrors every bus publish onto the `GlobalBus`, which is what `/global/event`
       * relays to the app shell. Both surfaces are fed by this one call.
       *
       * ⚠️ It emitted DIRECTLY to the `GlobalBus` as well for one commit, and the duplicate is why
       * this comment exists: `httpapi-config-no-teardown` collects disposals off that bus and saw
       * each one twice. A second producer for one fact is the defect, not the symptom — the mirror
       * was always going to carry it.
       *
       * `Effect.ignore` because a dispose may not fail on a notification. `project` is the one field
       * the mirror derives itself, from the instance context, rather than taking it from here, and no
       * consumer of a disposal reads it.
       */
      const emitDisposed = (input: { directory: string }) =>
        bus
          .publish(
            InstanceEvent.Disposed,
            { directory: input.directory },
            { location: { directory: AbsolutePath.make(input.directory) } },
          )
          .pipe(Effect.ignore)

      const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
        yield* Log.event("instance.store.dispose", { directory: ctx.directory })
        // A disposer that refuses to let go is NAMED here. It used to fail silently, which at shutdown
        // meant unflushed state was lost with nothing on record to say which subsystem lost it.
        const failures = yield* Effect.promise(() => runDisposers(ctx.directory))
        if (failures.length > 0)
          yield* Log.event("instance.disposer.run.failed", {
            directory: ctx.directory,
            "instance.disposers": describeDisposeFailures(failures),
          })
        yield* emitDisposed({ directory: ctx.directory })
      })

      const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
        if (cache.get(directory) !== entry) return false
        yield* disposeContext(ctx)
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

      const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
        const directory = FSUtil.resolve(input.directory)
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const existing = cache.get(directory)
            if (existing) return yield* restore(Deferred.await(existing.deferred))

            const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
            cache.set(directory, entry)
            yield* Effect.gen(function* () {
              yield* Log.event("instance.store.create", { directory })
              yield* completeLoad(directory, input, entry)
            }).pipe(Effect.forkIn(scope, { startImmediately: true }))
            return yield* restore(Deferred.await(entry.deferred))
          }),
        ).pipe(Effect.withSpan("InstanceStore.load"))
      }

      const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
        const directory = FSUtil.resolve(input.directory)
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const previous = cache.get(directory)
            const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
            cache.set(directory, entry)
            yield* Effect.gen(function* () {
              yield* Log.event("instance.store.reload", { directory })
              if (previous) {
                yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
                const reloadFailures = yield* Effect.promise(() => runDisposers(directory))
                if (reloadFailures.length > 0)
                  yield* Log.event("instance.disposer.run.failed", {
                    directory,
                    "instance.disposers": describeDisposeFailures(reloadFailures),
                  })
                yield* emitDisposed({ directory })
              }
              yield* completeLoad(directory, input, entry)
            }).pipe(Effect.forkIn(scope, { startImmediately: true }))
            return yield* restore(Deferred.await(entry.deferred))
          }),
        ).pipe(Effect.withSpan("InstanceStore.reload"))
      }

      const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
        const entry = cache.get(ctx.directory)
        if (!entry) return yield* disposeContext(ctx)

        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
        if (exit.value !== ctx) return
        yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
      })

      const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
        const directory = FSUtil.resolve(input)
        const entry = cache.get(directory)
        if (!entry) return
        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
        yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
      })

      const disposeAllOnce = Effect.fnUntraced(function* () {
        yield* Log.event("instance.store.dispose.all", {})
        yield* Effect.forEach(
          [...cache.entries()],
          (item) =>
            Effect.gen(function* () {
              const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
              if (Exit.isFailure(exit)) {
                yield* Log.event("instance.store.dispose.failed", {
                  directory: item[0],
                  "instance.cause": Log.fault(exit.cause),
                })
                yield* removeEntry(item[0], item[1])
                return
              }
              yield* disposeEntry(item[0], item[1], exit.value)
            }),
          { discard: true },
        )
      })

      const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
      const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
        return yield* cachedDisposeAll
      })

      const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

      yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

      return Service.of({
        load,
        reload,
        dispose,
        disposeDirectory,
        disposeAll,
        provide,
      })
    }),
  )

export const defaultLayer = layer.pipe(Layer.provide(ProjectV2.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [ProjectV2.node, InstanceBootstrapGraph.node, EventV2Bridge.node],
})

export * as InstanceStore from "./instance-store"
