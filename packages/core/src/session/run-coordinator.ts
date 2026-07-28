export * as SessionRunCoordinator from "./run-coordinator"

import { Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionSchema } from "./schema"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, false)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt }
  })

// ── The wake seam (B1, 2026-07-28) ─────────────────────────────────────────────────────────────
//
// A session runs only when something calls `SessionExecution.wake`, and until B1 that had exactly
// four production callers — all request-driven inside `SessionV2` (prompt / command /
// switchResponder / compact). Nothing anywhere polled, subscribed or timed. So the two paths that
// create work with NO request behind them — `SessionSpawner.spawn` (the `spawn` tool) and the
// command-as-subagent branch — admitted the child's opening prompt with delivery "queue" and
// returned to nobody: the child never ran, so `exit()` was unreachable, so both `wait` surfaces
// (`SessionV2.wait`, `tool/wait.ts`) could only poll for ~2 minutes and then fail. The tool told
// the model the child "will run its prompt on the next scheduler cycle" — there was no cycle.
//
// The spawner cannot simply depend on `SessionExecution`. That node is global-UNBOUND
// (`session/execution.ts`) and its only implementation depends on `LocationServiceMap` — the map
// that BUILDS the location graph the spawner lives in. The edge is not merely a design smell:
// `buildLocationServiceMap` hoists global nodes out of each location subtree and compiles them,
// and `LayerNode.compile` THROWS `Unbound layer node` when it reaches one, so adding the
// dependency breaks every location boot — including the plain `locationServiceMapLayer` the CLI
// debug commands use, which carries no replacement for it at all.
//
// So the wake travels the way `SessionScheduler` already travels between these same two scopes: a
// GLOBAL node with NO dependencies whose in-memory state is shared by the instance graph and by
// every location graph hoisted out of it. That sharing is mechanism, not hope — `LayerMap` builds
// each location layer with the ENCLOSING MemoMap (`Layer.CurrentMemoMap.getOrCreate`,
// effect/src/LayerMap.ts:155) and `buildLocationServiceMap` provides the hoisted group OUTSIDE the
// per-location `Layer.fresh`, so one module-level layer object memoizes to ONE instance per
// composition root. It is the same mechanism that gives the HTTP diagnostics handler and the
// location-scoped runner a single EEVDF ledger.
//
// Whoever holds `SessionExecution` ATTACHES its wake (`SessionV2.layer` does, next to the four
// request-driven callers); the spawner CALLS it. Neither module imports the other, so the cycle
// the spawner's header warns about stays open.

export interface WakeInterface {
  /**
   * Hands a session to the attached executor. Returns FALSE when nothing is attached: the admitted
   * input is durable and stays queued, but no fiber in this process will run it. The caller must
   * say that instead of reporting success (ruling 2 — a failed mutation never reports success).
   */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Installs this instance's executor. A later attach replaces an earlier one. */
  readonly attach: (executor: (sessionID: SessionSchema.ID) => Effect.Effect<void>) => Effect.Effect<void>
}

export class Wake extends Context.Service<Wake, WakeInterface>()("@novaclaw/v2/SessionWake") {}

export const wakeLayer = Layer.effect(
  Wake,
  Effect.sync(() => {
    let executor: ((sessionID: SessionSchema.ID) => Effect.Effect<void>) | undefined
    return Wake.of({
      attach: (next) =>
        Effect.sync(() => {
          executor = next
        }),
      wake: (sessionID) =>
        executor === undefined
          ? Effect.logWarning("session wake dropped — no executor attached; queued input will not run", {
              sessionID,
            }).pipe(Effect.as(false))
          : executor(sessionID).pipe(Effect.as(true)),
    })
  }),
)

export const wakeNode = makeGlobalNode({ service: Wake, layer: wakeLayer, deps: [] })
