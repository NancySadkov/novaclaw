export * as SessionJoin from "./join"

import { Context, Effect, Layer, Option, Stream } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"
import { SessionStore } from "./store"

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
export interface Parts {
  readonly events: EventV2.Interface
  /** Current projected row. A newly admitted prompt clears `result`, reopening the child. */
  readonly session: (childID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  /** Aggregate head sampled BEFORE the row, closing the read/subscribe race. */
  readonly sequence: (childID: SessionSchema.ID) => Effect.Effect<number>
}

const render = (result: unknown): string =>
  typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result)

/**
 * Join the child's CURRENT execution epoch, not the first completion in its lifetime.
 *
 * A helper can settle mechanically, accept a follow-up, then complete again. Replaying from sequence
 * zero and taking `runHead` returned the first answer forever. The projected `session.result` is the
 * current-state authority, and prompt admission clears it. Sampling the aggregate head first makes
 * this race-free:
 *
 * - completion before the head is visible in the projected row;
 * - completion between the head and row read is visible in the row or after `head`;
 * - completion after the row read is replayed/tail-read after `head`.
 */
export const fromParts = (parts: Parts): Interface => ({
  awaitCompletion: ({ childID, timeoutMs }) =>
    Effect.gen(function* () {
      const after = yield* parts.sequence(childID)
      const current = yield* parts.session(childID)
      if (current?.result !== undefined) return { completed: true, result: render(current.result) } satisfies Outcome

      const completed = yield* parts.events.durable({ aggregateID: childID, after }).pipe(
        Stream.filter((event) => event.type === SessionEvent.Completed.type),
        Stream.map((event) => event as EventV2.Payload<typeof SessionEvent.Completed>),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
        // A timeout is a legitimate ANSWER, not a failure: the child may simply still be working.
        Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(undefined) }),
      )
      return completed === undefined
        ? ({ completed: false } satisfies Outcome)
        : ({ completed: true, result: render(completed.data.result) } satisfies Outcome)
    }).pipe(Effect.orDie),
})

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionJoin") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const { db } = yield* Database.Service
    return Service.of(
      fromParts({
        events,
        session: (childID) => sessions.get(childID),
        sequence: (childID) => EventV2.latestSequence(db, childID),
      }),
    )
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, SessionStore.node, Database.node] })
