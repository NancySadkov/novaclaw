import { Cause, Clock, Context, Effect, Exit, Layer, Option, Ref, Scope, Semaphore } from "effect"
import { Log } from "@novaclaw/schema/log"

export type Unavailable = {
  readonly capability: string
  readonly kind: "failed" | "timeout" | "disabled" | "unsupported"
  readonly summary: string
  readonly detail?: string
  readonly repair?: readonly string[]
}

export type Status =
  | { readonly state: "idle" }
  | { readonly state: "starting"; readonly since: number }
  | { readonly state: "ready"; readonly since: number }
  | { readonly state: "unavailable"; readonly reason: Unavailable; readonly at: number; readonly attempts: number }

export type Result<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: Unavailable }

export interface Capability<A> {
  readonly name: string
  /** Build or reuse the capability. Failure is returned as data and is cached. */
  readonly get: Effect.Effect<Result<A>>
  /** Observe without starting the capability. */
  readonly status: Effect.Effect<Status>
  /** Re-arm a cached failure and make one new attempt. Ready capabilities are left alone. */
  readonly retry: Effect.Effect<Status>
}

type State<A> = {
  readonly status: Status
  readonly result?: Result<A>
  readonly attempts: number
}

export interface MakeOptions<A> {
  readonly name: string
  readonly service: Context.Service.Any
  readonly layer: Layer.Layer<unknown, unknown, unknown>
  readonly environment: Context.Context<unknown>
  readonly parentScope: Scope.Scope
  readonly timeout: import("effect").Duration.Input
  readonly repair?: readonly string[]
}

const unavailableFrom = (options: MakeOptions<unknown>, cause: Cause.Cause<unknown>): Unavailable => {
  const failure = Cause.findErrorOption(cause)
  const timeout = Option.isSome(failure) && Cause.isTimeoutError(failure.value)
  const summary = timeout
    ? `${options.name} timed out while starting.`
    : `${options.name} is unavailable: ${Cause.pretty(cause).split(/\r?\n/, 1)[0] || "startup failed"}`
  return {
    capability: options.name,
    kind: timeout ? "timeout" : "failed",
    summary,
    detail: Cause.pretty(cause),
    ...(options.repair === undefined ? {} : { repair: options.repair }),
  }
}

/**
 * Construct the runtime handle used by `LayerNode.capability`. The inner layer is built into a child
 * scope only when `get` is first run. One semaphore is both the single-flight latch and the retry
 * boundary: concurrent callers can never build two copies, and a cached refusal never stalls every
 * later call until an explicit retry re-arms it.
 */
export const make = <A>(options: MakeOptions<A>): Effect.Effect<Capability<A>> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<State<A>>({ status: { state: "idle" }, attempts: 0 })
    const lock = yield* Semaphore.make(1)

    const build = Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (current.result !== undefined) return current.result

      const since = yield* Clock.currentTimeMillis
      yield* Ref.set(state, { status: { state: "starting", since }, attempts: current.attempts })
      const childScope = yield* Scope.fork(options.parentScope)
      const outcome = yield* Layer.buildWithScope(options.layer, childScope).pipe(
        Effect.provide(options.environment),
        Effect.timeout(options.timeout),
        Effect.matchCause({
          onFailure: (cause) => ({ ok: false, cause }) as const,
          onSuccess: (context) => ({ ok: true, context }) as const,
        }),
      )
      const at = yield* Clock.currentTimeMillis
      if (!outcome.ok) {
        yield* Scope.close(childScope, Exit.failCause(outcome.cause)).pipe(Effect.ignore)
        const attempts = current.attempts + 1
        const error = unavailableFrom(options, outcome.cause)
        const result = { ok: false, error } as const
        yield* Log.event("instance.capability.start.failed", {
          "instance.capability": options.name,
          "instance.cause": Log.fault(outcome.cause),
        })
        yield* Ref.set(state, { status: { state: "unavailable", reason: error, at, attempts }, result, attempts })
        return result
      }

      const value = Context.get(outcome.context, options.service) as A
      const result = { ok: true, value } as const
      yield* Ref.set(state, { status: { state: "ready", since: at }, result, attempts: current.attempts + 1 })
      return result
    })

    const get = lock.withPermit(build)
    const retry = lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.status.state !== "unavailable") return current.status
        yield* Ref.set(state, { status: { state: "idle" }, attempts: current.attempts })
        yield* build
        return (yield* Ref.get(state)).status
      }),
    )

    return { name: options.name, get, status: Ref.get(state).pipe(Effect.map((current) => current.status)), retry }
  })

export * as Capability from "./capability"
