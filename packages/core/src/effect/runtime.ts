import { Layer, type Context, ManagedRuntime, type Effect } from "effect"
import { memoMap } from "./memo-map"
import { Observability } from "../observability"

/** Wraps every effect a runtime runs, before it is run. */
export type RuntimeWrap<I> = <A, Err>(effect: Effect.Effect<A, Err, I>) => Effect.Effect<A, Err, I>

/**
 * The ONE lazy `ManagedRuntime` factory. `packages/novaclaw/src/effect/run-service.ts` used to hold a
 * byte-similar second copy whose only real difference was that it wrapped every effect in `attach()`
 * — so whether a run inherited `InstanceRef`/`WorkspaceRef` from the current fiber depended on which
 * import the caller happened to reach for, and only one of the two had a test saying so.
 *
 * `wrap` is the seam that makes one body legal for both: the refs live in `packages/novaclaw` and
 * cannot be reached from here. It defaults to identity, which is right for core's own consumer
 * (`npm.ts`, whose directory resolves under `Global.Path.cache` and has no instance to attach).
 */
export function makeRuntime<I, S, E>(
  service: Context.Service<I, S>,
  layer: Layer.Layer<I, E>,
  wrap: RuntimeWrap<I> = (effect) => effect,
) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined
  const getRuntime = () =>
    (rt ??= ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer) as Layer.Layer<I, E>, {
      memoMap,
    }))

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(wrap(service.use(fn))),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(wrap(service.use(fn)), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(wrap(service.use(fn)), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(wrap(service.use(fn))),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) =>
      getRuntime().runCallback(wrap(service.use(fn))),
  }
}
