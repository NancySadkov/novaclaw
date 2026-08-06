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

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionJoin") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return Service.of({
      awaitCompletion: ({ childID, timeoutMs }) =>
        events.durable({ aggregateID: childID }).pipe(
          Stream.filter((event) => event.type === SessionEvent.Completed.type),
          Stream.map((event) => event as EventV2.Payload<typeof SessionEvent.Completed>),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
          // A timeout is a legitimate ANSWER here, not a failure: the child may simply still be
          // working. `wait`'s contract is "joined, or did not join within the budget".
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
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node] })
