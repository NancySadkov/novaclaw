export * as SessionJoin from "./join"

import { Context, Effect, Layer, Stream } from "effect"
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
 * ⚠️ It still has to be BOUNDED, so a wedged child cannot hold a caller forever. Seven minutes is
 * past a slow local turn and short enough for an officer to recover the slice in the same work turn.
 *
 * ⚠️ **It lives here because there were TWO joins and only one of them learned this** ().
 * `tool/wait.ts` owned the measurement above; `SessionV2.wait` — the `POST /api/session/:id/wait`
 * door — was a separate hand-rolled 2000ms×60 poll that still carried the falsified 2-minute bound,
 * under a comment claiming *"same semantics as the wait TOOL"*. Two doors onto one question must not
 * be able to answer it differently, so there is now one implementation and one constant.
 *
 * Milliseconds, because this crosses the worker protocol and a `Duration` does not.
 */
export const JOIN_TIMEOUT_MS = 7 * 60_000

export interface ProviderError {
  readonly message: string
  readonly tag?: string
  readonly retryable?: boolean
  readonly status?: number
  /** Repeated identical failures are one bounded diagnostic, with their frequency preserved. */
  readonly count: number
}

export interface Outcome {
  readonly completed: boolean
  /** The child's `exit(result)` payload, rendered. Absent when it timed out. */
  readonly result?: string
  /** Output plus reasoning tokens generated after this wait sampled the durable event head. */
  readonly generatedTokens: number
  /** True even when a failed stream persisted output but never returned an exact usage total. */
  readonly generatedAnyTokens: boolean
  /** Provider/API failures observed after that same head, deduplicated without losing counts. */
  readonly providerErrors: ReadonlyArray<ProviderError>
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
 * settled. The services already resolved there (`PermissionV2`, `SessionSpawner`) are
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
      let completed: EventV2.Payload<typeof SessionEvent.Completed> | undefined
      let generatedTokens = 0
      let generatedAnyTokens = false
      const failures = new Map<string, ProviderError>()
      const consume = (event: EventV2.Payload) => {
        if (event.type === SessionEvent.Completed.type) {
          completed = event as EventV2.Payload<typeof SessionEvent.Completed>
          return
        }
        if (event.type === SessionEvent.Step.Ended.type) {
          const ended = event as EventV2.Payload<typeof SessionEvent.Step.Ended>
          const count = Math.max(0, ended.data.tokens.output) + Math.max(0, ended.data.tokens.reasoning)
          generatedTokens += count
          generatedAnyTokens ||= count > 0
          return
        }
        if (
          event.type === SessionEvent.Text.Progress.type ||
          event.type === SessionEvent.Text.Ended.type ||
          event.type === SessionEvent.Reasoning.Progress.type ||
          event.type === SessionEvent.Reasoning.Ended.type ||
          event.type === SessionEvent.Tool.Input.Progress.type ||
          event.type === SessionEvent.Tool.Input.Ended.type
        ) {
          const data = event.data as { readonly delta?: unknown; readonly text?: unknown }
          generatedAnyTokens ||=
            (typeof data.delta === "string" && data.delta.length > 0) ||
            (typeof data.text === "string" && data.text.length > 0)
          return
        }
        if (event.type !== SessionEvent.Step.Failed.type) return
        const failed = event as EventV2.Payload<typeof SessionEvent.Step.Failed>
        const error = failed.data.error
        const key = JSON.stringify([error._tag, error.status, error.retryable, error.message])
        const previous = failures.get(key)
        failures.set(key, {
          message: error.message,
          ...(error._tag === undefined ? {} : { tag: error._tag }),
          ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
          ...(error.status === undefined ? {} : { status: error.status }),
          count: (previous?.count ?? 0) + 1,
        })
      }
      const durable = parts.events.durable({ aggregateID: childID, after })
      if (current?.result !== undefined) {
        // Completion may land between sampling `after` and reading the projected row. Consume exactly
        // the now-durable delta so tokens/errors generated inside that race are not reported as zero;
        // a completion already present before this call has a zero delta and returns immediately.
        const through = yield* parts.sequence(childID)
        yield* durable.pipe(
          Stream.take(Math.max(0, through - after)),
          Stream.runForEach((event) => Effect.sync(() => consume(event))),
        )
        return {
          completed: true,
          result: render(current.result),
          generatedTokens,
          generatedAnyTokens,
          providerErrors: [...failures.values()],
        } satisfies Outcome
      }

      const stream = durable.pipe(
        Stream.takeUntil((event) => event.type === SessionEvent.Completed.type),
        Stream.runForEach((event) => Effect.sync(() => consume(event))),
      )
      // A timeout is a legitimate ANSWER, not a failure: the child may simply still be working.
      yield* stream.pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.void }))
      const diagnostics = { generatedTokens, generatedAnyTokens, providerErrors: [...failures.values()] }
      return completed === undefined
        ? ({ completed: false, ...diagnostics } satisfies Outcome)
        : ({ completed: true, result: render(completed.data.result), ...diagnostics } satisfies Outcome)
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

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, SessionStore.node, Database.node],
})
