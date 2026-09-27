export * as SessionJoin from "./join"

import { Context, Duration, Effect, Layer, Stream } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionExecutionAttempt } from "./execution-attempt"
import type { SessionSchema } from "./schema"
import { SessionStore } from "./store"
export { JOIN_TIMEOUT_MS } from "./join-deadline"
import { JOIN_TIMEOUT_MS } from "./join-deadline"

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
  /**
   * 🔴 The child reached a terminal execution state WITHOUT completing, and this is that state.
   *
   * Absent means "still working" (or "already completed"), never "the wait gave up". The distinction
   * is the whole point: a caller told only `completed: false` cannot tell a dead child from a slow
   * one, and answers the slow case by waiting again for seven minutes.
   */
  readonly halted?: SessionExecutionAttempt.HaltedState
}

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
  /**
   * The child's current execution attempt — the liveness signal, and REQUIRED.
   *
   * 🔴 **Without it a join can only learn that a child FINISHED, never that it DIED**, and the two
   * are indistinguishable until the seven-minute bound expires. Measured: the user pressed Stop on a
   * worker, `requestInterrupt` wrote `interrupted`, and the parent's `wait` sat on a `Completed`
   * event that was never coming for the rest of its bound — the transcript row said "Waiting for
   * worker" over a worker that had been dead in front of them, and the tool then told the model the
   * child "may still be working".
   *
   * Optional-with-a-fallback was the alternative and it is the defect again: a graph that omitted it
   * would be correct until the first stop, which is the one case anybody notices.
   */
  readonly attempt: (childID: SessionSchema.ID) => Effect.Effect<SessionExecutionAttempt.Info | undefined>
}

/**
 * How often the join re-reads the attempt row while it waits.
 *
 * 🔴 **A poll, on purpose, and the durable stream is still what ends a COMPLETION.** The completion
 * side is an event because a completion is a fact about the aggregate; a halt is a fact about the
 * execution ledger, which has no event of its own, and inventing one would mean every terminal
 * transition wrote a durable row the projection then had to learn to ignore. One indexed primary-key
 * read every two seconds, for a wait bounded at seven minutes, against a table with at most one row
 * per live session.
 *
 * The interval is what "immediately" costs. A second would catch a stop sooner and cost 420 reads
 * per wait; a heartbeat is already five seconds (`execution/local.ts`), so nothing legitimate turns
 * over faster than this anyway.
 */
export const HALT_POLL_INTERVAL = Duration.seconds(2)

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
      /**
       * 🔴 **The liveness predicate is consulted WHILE the wait runs, not only at its edges.**
       *
       * Reading the attempt row before subscribing and again after the bound was the original defect:
       * between those two reads a child can die, and dying emits no `Completed` event, so the wait
       * could only end by timeout. `raceFirst` interrupts the loser, so a halt ends the join at once
       * and a completion ends the halt watch at once — neither pays for the other.
       */
      const watchForHalt = Effect.gen(function* () {
        while (true) {
          const attempt = yield* parts.attempt(childID)
          if (attempt !== undefined && SessionExecutionAttempt.halted(attempt.state)) return attempt.state
          yield* Effect.sleep(HALT_POLL_INTERVAL)
        }
      })
      const wake = yield* Effect.raceFirst(
        stream.pipe(Effect.as({ kind: "completed" } as const)),
        watchForHalt.pipe(Effect.map((state) => ({ kind: "halted", state }) as const)),
      ).pipe(
        // A timeout is a legitimate ANSWER, not a failure: the child may simply still be working.
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.succeed({ kind: "timed-out" } as const),
        }),
      )
      const diagnostics = { generatedTokens, generatedAnyTokens, providerErrors: [...failures.values()] }
      if (wake.kind !== "halted")
        return completed === undefined
          ? ({ completed: false, ...diagnostics } satisfies Outcome)
          : ({ completed: true, result: render(completed.data.result), ...diagnostics } satisfies Outcome)

      /**
       * The halt watch can win a race the completion already won: `settle` runs in the drain's
       * `onExit`, and a child that called `exit()` and settled in the same tick is terminal by both
       * facts. So the same head-then-row-then-delta order the entry path uses is replayed here before
       * a child is called dead — a false death is the one answer a supervisor must never give.
       */
      const through = yield* parts.sequence(childID)
      const settledRow = yield* parts.session(childID)
      if (settledRow?.result !== undefined)
        return { completed: true, result: render(settledRow.result), ...diagnostics } satisfies Outcome
      yield* durable.pipe(
        Stream.take(Math.max(0, through - after)),
        Stream.runForEach((event) => Effect.sync(() => consume(event))),
      )
      if (completed !== undefined)
        return { completed: true, result: render(completed.data.result), ...diagnostics } satisfies Outcome
      return { completed: false, halted: wake.state, ...diagnostics } satisfies Outcome
    }).pipe(Effect.orDie),
})

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionJoin") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const attempts = yield* SessionExecutionAttempt.Service
    const { db } = yield* Database.Service
    return Service.of(
      fromParts({
        events,
        session: (childID) => sessions.get(childID),
        sequence: (childID) => EventV2.latestSequence(db, childID),
        attempt: (childID) => attempts.get(childID),
      }),
    )
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, SessionStore.node, Database.node, SessionExecutionAttempt.node],
})
