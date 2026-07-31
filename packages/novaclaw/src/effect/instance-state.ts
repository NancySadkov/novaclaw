import { Cause, Effect, Exit, ScopedCache, Scope } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@novaclaw/core/workspace"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~novaclaw/InstanceState"

/**
 * The context refs one cached entry was BUILT under.
 *
 * ⚠️ Load-bearing rather than bookkeeping. `make`'s lookup below IGNORES the cache key and reads
 * `InstanceRef` off the fiber, so any operation that re-runs the lookup for a key OTHER than the
 * calling fiber's instance would store one instance's value under another instance's key. The
 * fan-outs (`rematerializeAll`, `forEachCached`) exist to serve an instance-wide config write, whose
 * fiber may be any instance's or none — so they re-provide the refs recorded here instead.
 */
interface BuiltUnder {
  readonly instance: InstanceContext
  readonly workspace: WorkspaceV2.ID | undefined
}

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
  readonly built: Map<string, BuiltUnder>
}

/**
 * An `InstanceState` whose owner has DECLARED that re-running its initializer is safe.
 *
 * ⚠️ This marker is the mechanical half of v0.2.0-prep B7 tier-3's one hard rule (todo.md ruling 1 —
 * an invariant whose violation compiles green ships with a check or it does not exist).
 * `rematerializeAll` builds a replacement value and then CLOSES the superseded entry's scope, which
 * runs every finalizer the initializer registered. For `MCP.state` that finalizer walks `s.clients`
 * and tree-kills every connected server's child processes — i.e. exactly the stop-the-world teardown
 * B7 exists to delete, wearing a smaller footprint. So a cache that owns an external resource must
 * never be reachable from that function, and the type is what stops it: only
 * {@link makeRematerializable} produces this marker, and `mcp/index.ts` deliberately does not call it.
 */
export interface Rematerializable<A, E = never, R = never> extends InstanceState<A, E, R> {
  readonly rematerializable: true
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

const makeWith = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const built = new Map<string, BuiltUnder>()
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          const ctx = yield* context
          // Recorded BEFORE `init` runs: an initializer that fails leaves no cache entry, but a
          // later successful one for the same directory overwrites this with identical refs.
          built.set(ctx.directory, { instance: ctx, workspace: yield* WorkspaceRef })
          return yield* init(ctx)
        }),
    })

    const off = registerDisposer(async (directory) => {
      await Effect.runPromise(ScopedCache.invalidate(cache, directory))
      // The refs outlive nothing: a disposed instance's entry is gone, so keeping its context would
      // let a later fan-out rebuild a cache entry for an instance the process has already closed.
      built.delete(directory)
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
      built,
    }
  })

export const make = makeWith

/**
 * Like {@link make}, but declares that re-running `init` for an already-cached instance is SAFE —
 * see {@link Rematerializable} for what "safe" means and why it is a type rather than a comment.
 *
 * The bar: the initializer must own no resource whose finalizer has an effect outside this process's
 * own memory. A pure derivation of config into a value qualifies (`Config.state`, `Format.state`); a
 * connection, a child process, a subscription or a pending user prompt does not.
 */
export const makeRematerializable = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<Rematerializable<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.map(makeWith(init), (state) => ({ ...state, rematerializable: true as const }))

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

/**
 * Run `effect` under the refs one cached entry was built with.
 *
 * Deliberately a local four-liner rather than a reuse of `run-service.ts`'s identical `attachWith`:
 * that module pulls `ManagedRuntime` and `Observability` in, and this one is imported by eleven
 * services plus the config layer, so borrowing the helper would widen all of their import graphs to
 * avoid four lines. Both `InstanceRef` and `WorkspaceRef` are `Context.Reference`s carrying defaults,
 * so providing them erases nothing from `R` — hence the annotation, which mirrors `attachWith`'s.
 */
const attachRefs = <A, E, R>(effect: Effect.Effect<A, E, R>, refs: BuiltUnder): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(InstanceRef, refs.instance), Effect.provideService(WorkspaceRef, refs.workspace))

/**
 * Re-run the initializer for EVERY instance this cache currently holds, replacing each value.
 *
 * v0.2.0-prep B7 tier-3 / ruling 3 — *a settings change is not a reboot.* A config write is
 * INSTANCE-WIDE while these caches are per-instance-directory, so the fan-out is the point: one
 * process holds one entry per open instance and all of them re-derive, exactly as
 * `ConfigStoreWrite`'s per-domain registry fans out across open locations.
 *
 * Three properties, each of which took a measurement to establish rather than a guess:
 *
 *  · **It re-provides the refs the entry was built under** (`built` above). `ScopedCache.refresh`
 *    calls `self.lookup(key)`, and this module's lookup reads `InstanceRef` off the fiber and ignores
 *    the key — so refreshing from the config-write fiber without this would write one instance's
 *    document under another instance's key. That is silent, and it is a data mix-up rather than a
 *    stale read.
 *  · **It builds before it releases.** `ScopedCache.refresh` runs the new lookup to completion, swaps
 *    the map entry, and only then closes the superseded entry's scope (effect@4.0.0-beta.83,
 *    `ScopedCache.js` → `refresh`). So a reader never observes a gap — the same ordering
 *    `filesystem/watcher.ts` establishes by hand for its subscriptions, and for the same reason.
 *  · **It closes the old scope, which is why {@link Rematerializable} gates it.** See that type.
 *
 * ⚠️ **A FAILED rebuild puts the previous value back, and that is not defensive padding — without it
 * this function is worse than the staleness it cures.** `ScopedCache` caches *failed* lookup exits
 * under the same TTL as successful ones (`make`'s `defaultTimeToLive` is `Duration.infinity`), and
 * `refresh` overwrites the map entry with the new exit whether it succeeded or not. So one failing
 * rebuild — a `.well-known` config source that is unreachable while the user saves a preference —
 * would replace a perfectly good document with a permanently cached failure, and every later read for
 * that instance would die until the instance was disposed. Restoring makes the outcome the one
 * `refreshDomains` already documents for a broken domain: **stale, never torn**. The failure is then
 * re-raised so the write is reported as *committed, not live* rather than as silently applied.
 *
 * ⚠️ And the raise happens AFTER the fan-out, not inside it, for the same reason. Failing from inside
 * an unbounded `forEach` interrupts its siblings — and an INTERRUPTED `ScopedCache.refresh` caches the
 * interrupt exit exactly the way it caches a failure, so one unreachable instance would poison every
 * other instance's document as collateral.
 */
export const rematerializeAll = <A, E, R>(self: Rematerializable<A, E, R>): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const entries = yield* ScopedCache.entries(self.cache)
    const failures: Cause.Cause<E>[] = []
    yield* Effect.forEach(
      entries,
      ([key, previous]) => {
        const refs = self.built.get(key)
        // Unreachable in practice (a resolved entry always recorded its refs), and a skip is the
        // right answer anyway: rebuilding without the refs is the mix-up described above.
        if (!refs) return Effect.void
        return attachRefs(ScopedCache.refresh(self.cache, key), refs).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : // `set` also closes the failed entry's scope, so a partially-built value releases
                // whatever it did acquire before the previous one is put back in its place.
                ScopedCache.set(self.cache, key, previous).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      failures.push(exit.cause)
                    }),
                  ),
                ),
          ),
        )
      },
      { discard: true, concurrency: "unbounded" },
    )
    if (failures.length === 0) return
    // `Cause.combine`, folded by hand rather than through `reduce`: it is a dual, and `reduce` hands
    // its callback four arguments, which is exactly the shape a dual's arity dispatch gets wrong.
    let cause = failures[0]
    for (let index = 1; index < failures.length; index++) cause = Cause.combine(cause, failures[index])
    return yield* Effect.failCause(cause)
  })

/**
 * Run `f` against every value this cache currently holds, under that entry's own refs.
 *
 * The counterpart to {@link rematerializeAll} for a cache that must NOT be rebuilt: it hands the
 * LIVE value to a caller that reconciles it in place. `MCP.state` is the reason this exists — the
 * cure for a changed `mcp.servers` is to connect what is new and close what is gone, never to
 * rebuild the set (which would tree-kill every server the user did not touch).
 *
 * Reads only entries that resolved successfully (`ScopedCache.entries`), so a pending or failed
 * initializer is skipped rather than awaited — a config write must not block on a server that is
 * still connecting.
 */
export const forEachCached = <A, E, R, X, E2, R2>(
  self: InstanceState<A, E, R>,
  f: (value: A, ctx: InstanceContext) => Effect.Effect<X, E2, R2>,
): Effect.Effect<void, E2, R2> =>
  Effect.gen(function* () {
    const entries = yield* ScopedCache.entries(self.cache)
    yield* Effect.forEach(
      entries,
      ([key, value]) => {
        const refs = self.built.get(key)
        if (!refs) return Effect.void
        return attachRefs(f(value, refs.instance), refs).pipe(Effect.asVoid)
      },
      { discard: true, concurrency: "unbounded" },
    )
  })

export * as InstanceState from "./instance-state"
