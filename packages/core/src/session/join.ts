export * as SessionJoin from "./join"

import { Context, Effect, Layer, Option, Stream } from "effect"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"

/**
 * Awaiting a child session's completion — the half of `wait` that a session WORKER cannot do.
 *
 * 🔴 **Why this is a service and not four lines inside `tool/wait.ts`.** The tool joined a child with
 * `events.durable({aggregateID})`, and the worker's `EventV2` replacement is
 * `durable: () => Stream.die(unavailable("durable event stream"))`. So `wait` died in every session
 * worker with *"only works in host-only contexts"* — the same class of outage as `spawn`, found the
 * moment fixing spawn let the live smoke reach test 8. A service is a seam the worker can REPLACE
 * with an RPC to the host; a direct `events.durable` call is not.
 *
 * ⚠️ **The direct-child check stays in the TOOL, deliberately.** `SessionStore` is NOT replaced in a
 * worker — it reads the database — so `store.get` works on both sides and the authorisation check
 * belongs where it already is. Only the part that genuinely needs host-owned machinery moved. (An
 * earlier note of mine claimed the store was unavailable in a worker; that was wrong, and moving the
 * check would have been a needless widening of this seam.)
 *
 * **This is a request/response, not a stream, and that is what makes the RPC cheap.** `wait` only ever
 * took `Stream.runHead` with a timeout — the FIRST completion or nothing. Forwarding a live stream
 * across the worker protocol would have been a far larger job for a value nobody reads.
 */
/**
 * **THE bound on a join, for every door into it.**
 *
 * 🔴 **Raised from 2 minutes on 2026-08-20 because 2 minutes is shorter than one child's TURN.**
 * Measured: a child asked only to reply "BANANA" settled **121.7 seconds** after `wait` started, and
 * `wait` had given up 1.6 seconds earlier. Nothing was wrong; parent and child share one local model
 * server, so the child's single inference queued behind the parent's own. A join whose timeout is the
 * same order as one inference reports a false negative on a healthy run, which is exactly what a
 * supervisor must never do.
 *
 * ⚠️ It still has to be BOUNDED, so a wedged child cannot hold a caller forever. Ten minutes is well
 * past a slow local turn and well short of a hang.
 *
 * ⚠️ **It lives here because there were TWO joins and only one of them learned this** (RF-03-1).
 * `tool/wait.ts` owned the measurement above; `SessionV2.wait` — the `POST /api/session/:id/wait`
 * door — was a separate hand-rolled 2000ms×60 poll that still carried the falsified 2-minute bound,
 * under a comment claiming *"same semantics as the wait TOOL"*. Two doors onto one question must not
 * be able to answer it differently, so there is now one implementation and one constant.
 *
 * Milliseconds, because this crosses the worker protocol and a `Duration` does not.
 */
export const JOIN_TIMEOUT_MS = 10 * 60_000

export interface Outcome {
  readonly completed: boolean
  /** The child's `exit(result)` payload, rendered. Absent when it timed out. */
  readonly result?: string
}

export interface Interface {
  readonly awaitCompletion: (input: {
    readonly childID: SessionSchema.ID
    readonly timeoutMs: number
  }) => Effect.Effect<Outcome>
}

/**
 * 🔴 **Build the join from an EventV2 you already hold — do NOT resolve `Service` inside a
 * per-request handler.**
 *
 * Measured 2026-08-06, and it cost a revert. `session-worker/execution.ts` resolves services inside
 * `onInteractionRequest`'s `runLocated(...)`; adding `yield* SessionJoin.Service` there abandoned
 * EVERY tool-call turn — the tool part landed, the drain stopped, the assistant message never
 * settled. The services already resolved there (`PermissionV2`, `QuestionV2`, `SessionSpawner`) are
 * all ALREADY in the location graph, so resolving them constructs nothing new; `SessionJoin` was new,
 * and forcing its layer to build inside that per-request scope is what broke the drain.
 *
 * So the host side takes this function and never touches the graph. `Service`/`layer`/`node` below
 * exist for the WORKER side only, where `tool/wait.ts` consumes the tag and the worker replaces it
 * with an RPC.
 */
export const fromEvents = (events: EventV2.Interface): Interface => ({
  awaitCompletion: ({ childID, timeoutMs }) =>
    events.durable({ aggregateID: childID }).pipe(
      Stream.filter((event) => event.type === SessionEvent.Completed.type),
      Stream.map((event) => event as EventV2.Payload<typeof SessionEvent.Completed>),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      // A timeout is a legitimate ANSWER, not a failure: the child may simply still be working.
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(undefined) }),
      Effect.map((completed): Outcome => {
        if (!completed) return { completed: false }
        const result = completed.data.result
        const rendered = typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result)
        return { completed: true, result: rendered }
      }),
      Effect.orDie,
    ),
})

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionJoin") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of(fromEvents(yield* EventV2.Service))
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node] })
