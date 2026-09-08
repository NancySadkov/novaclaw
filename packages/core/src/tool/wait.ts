export * as WaitTool from "./wait"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionStore } from "../session/store"
import { SessionExecutionAttempt } from "../session/execution-attempt"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { SessionJoin } from "../session/join"

// wait(sessionID) — join on a DIRECT child session's completion (architecture.md step 5), the
// complement to spawn/exit. The durable aggregate stream closes the read/subscribe race: it replays a
// completion that already landed, then tails future durable events without polling SQLite every two
// seconds. Blocking within the turn is intended (like bash's long timeouts).

/**
 * 🔴 **A DEAD child must not read as a slow one.** `awaitCompletion` waits for a `Completed` event,
 * so a child that crashed, failed or was interrupted emits nothing and times out exactly like one
 * still working — and the ordinary timeout message then tells the parent, truthfully for the live
 * case and disastrously for the dead one, that *"this is not an error and does not mean it failed"*.
 *
 * Measured 2026-08-27 on a delegated 100-file run: `spawn:10` against `wait:9` and `exit:9`. One
 * child was launched and never accounted for, the run completed anyway, and nothing surfaced it.
 * ⭐ **That is the shape that matters: nine slices of ten merge into a plausible,
 * complete-looking, WRONG answer**, and the nine successes are exactly what hide the tenth.
 *
 * ⚠️ **Only a state that CANNOT recover counts as dead.** `recovering`, `starting` and `busy` are
 * alive; calling any of those dead would send the parent to duplicate work a live child is doing —
 * the opposite error, and an expensive one on a device this fan-out is meant to saturate. An ABSENT
 * attempt row is also not dead: it means the child has not started yet, or the row was pruned.
 *
 * 🔴 **The criterion is NOT "did something go wrong" — it is *will anything move this child without
 * a human?*** Those are different questions, and reading the first one is what put `paused` on the
 * live side of this predicate for as long as it existed. A paused attempt is written precisely when
 * `SessionRecoveryDecision.decide` returns `automatic: false` (the circuit breaker after
 * `FAILURE_LIMIT`, or a tool dispatched with an unknown outcome), `SessionBootRecovery` resumes only
 * the `automatic` half, and `recoverStale` never even selects `paused`. Nothing in the recovery
 * machinery leaves that state; only `authorizeRetry` — an operator action — does. So a parent told
 * *"it may still be working"* about a paused child waits ten minutes a lap, forever.
 */
/**
 * ⭐ **The classification is EXHAUSTIVE over `SessionExecutionAttempt.State`, by construction.** A
 * predicate that lists the states it acts on silently ignores the next one somebody adds, and the
 * ignored default here is *"alive"* — the direction that strands a parent. `Unclassified` below is
 * a type error the moment a state is added to the union without an answer to the question above.
 */
const HALTED_STATES = ["failed", "interrupted", "paused"] as const
const PROGRESSING_STATES = ["starting", "busy", "recovering", "settled"] as const
type Classified = (typeof HALTED_STATES)[number] | (typeof PROGRESSING_STATES)[number]
type Unclassified = Exclude<SessionExecutionAttempt.State, Classified>
const _everyAttemptStateIsClassified: [Unclassified] extends [never]
  ? true
  : ["classify this attempt state in wait.ts", Unclassified] = true
void _everyAttemptStateIsClassified

const isHalted = (state: string | undefined): state is (typeof HALTED_STATES)[number] =>
  HALTED_STATES.includes(state as (typeof HALTED_STATES)[number])

export const deadChildMessage = (childID: string, state: string | undefined): string | undefined => {
  if (!isHalted(state)) return undefined
  // ⚠️ Paused gets its OWN sentence rather than being folded into the failure wording. The parent's
  // next move differs: a failed slice is re-issued, a paused one has a durable attempt row a person
  // must look at, and telling the model "it failed" about a parked child invites it to silently
  // respawn work whose side effects are of unknown status — which is exactly the state `paused` is
  // recorded for. Principle 14: this goes in the reply; nothing blocks waiting for the operator.
  if (state === "paused")
    return (
      `Session ${childID} DID NOT FINISH: its execution is PAUSED for operator inspection and will ` +
      `not resume on its own. It is not still working and waiting again will not help. Its share of ` +
      `the work was NOT done — say so in your reply, and re-issue that slice yourself only if ` +
      `repeating it is safe; it may have been parked because a tool's outcome is unknown.`
    )
  return (
    `Session ${childID} DID NOT FINISH: its execution ${state === "failed" ? "failed" : "was interrupted"}. ` +
    `It is not still working and waiting again will not help. Its share of the work was NOT done — ` +
    `spawn a fresh replacement session for that slice before you treat the set as complete.`
  )
}

/**
 * Opaque session ids are copy-hostile model input. A one-character transcription error must not
 * strand an otherwise unambiguous join, but authority may never widen: candidates come exclusively
 * from this parent's direct-child set, and ambiguity still refuses.
 */
const withinOneEdit = (left: string, right: string): boolean => {
  if (left === right) return true
  if (Math.abs(left.length - right.length) > 1) return false
  if (left.length === right.length) {
    let differences = 0
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index] && ++differences > 1) return false
    }
    return differences === 1
  }
  const shorter = left.length < right.length ? left : right
  const longer = left.length < right.length ? right : left
  let shortIndex = 0
  let longIndex = 0
  let skipped = false
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex++
      longIndex++
      continue
    }
    if (skipped) return false
    skipped = true
    longIndex++
  }
  return true
}

export const resolveDirectChildID = (
  requested: SessionSchema.ID,
  directChildren: ReadonlyArray<SessionSchema.ID>,
): SessionSchema.ID | undefined => {
  const exact = directChildren.find((candidate) => candidate === requested)
  if (exact) return exact
  const nearby = directChildren.filter((candidate) => withinOneEdit(requested, candidate))
  return nearby.length === 1 ? nearby[0] : undefined
}

export const name = "wait"
export const sideEffect = "read" as const
/**
 * The bound, and its measurement, now live with the join itself — `SessionJoin.JOIN_TIMEOUT_MS`.
 *
 * ⚠️ **They moved because a SECOND join was carrying the falsified 2-minute value** ().
 * `SessionV2.wait`, behind `POST /api/session/:id/wait`, was a hand-rolled poll whose comment claimed
 * *"same semantics as the wait TOOL"* while it had neither this transport nor this bound — so the
 * HTTP door reported "operation unavailable" on healthy children the tool path was fixed for on
 * 2026-08-20. One constant, so that cannot happen again.
 */
const WAIT_TIMEOUT_MS = SessionJoin.JOIN_TIMEOUT_MS

export const Input = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The child session id to wait for (returned by a prior spawn)." }),
})

const StructuredOutput = Schema.Struct({ completed: Schema.Boolean, terminal: Schema.Boolean })
const Output = Schema.Struct({ ...StructuredOutput.fields, message: Schema.String })
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const store = yield* SessionStore.Service
    const join = yield* SessionJoin.Service
    // ⚠️ Resolved HERE, at layer scope, never inside `execute` — the note on `SessionJoin` records
    // that resolving a service per request cost a revert (2026-08-06).
    const attempts = yield* SessionExecutionAttempt.Service
    yield* tools
      .register({
        [name]: Tool.make({
          // Waiting observes controller-owned child state. Re-running it cannot duplicate the
          // child's work, so a process loss must not classify the join like an unknown write.
          sideEffect,
          description:
            "Block until a child session (spawned earlier) completes via exit(), then return its result. " +
            "Times out after ~10 minutes if the child has not completed.",
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({ completed: output.completed, terminal: output.terminal }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const requestedChildID = SessionSchema.ID.make(input.sessionID)
              const directChildren = yield* store.children(context.sessionID)
              const childID = resolveDirectChildID(requestedChildID, directChildren)
              if (!childID) {
                return yield* Effect.fail(
                  new ToolFailure({
                    message:
                      `Session ${requestedChildID} is not a direct child of this session.` +
                      (directChildren.length === 0 ? "" : ` Direct children: ${directChildren.join(", ")}.`),
                  }),
                )
              }

              // A boot deliberately leaves disposable worker attempts interrupted so their officer
              // can replace them. Inspect that durable terminal state BEFORE subscribing: checking
              // only after the ten-minute join made an already-dead worker look slow for ten minutes.
              const before = yield* attempts.get(childID).pipe(Effect.orElseSucceed(() => undefined))
              const alreadyDead = deadChildMessage(childID, before?.state)
              if (alreadyDead) return { completed: false, terminal: true, message: alreadyDead }

              // ⚠️ Through `SessionJoin`, never `events.durable` directly — the worker's EventV2
              // replacement DIES on the durable stream, which is what killed `wait` inside every
              // session worker. The service is the seam the worker swaps for a host RPC.
              const joined = yield* join.awaitCompletion({ childID, timeoutMs: WAIT_TIMEOUT_MS })
              /**
               * 🔴 **A DEAD child must not read as a slow one.** `awaitCompletion` waits for a `Completed`
               * event, so a child that crashed, was interrupted, or failed emits nothing and times out
               * exactly like one still working — and the message below then tells the parent, truthfully
               * for the live case and disastrously for the dead one, that *"this is not an error"*.
               *
               * Measured 2026-08-27 on a delegated 100-file run: `spawn:10` against `wait:9` and
               * `exit:9`. One child was launched and never accounted for, the run completed anyway, and
               * nothing surfaced it. ⭐ **That is the shape that matters: nine slices of ten merge into a
               * plausible, complete-looking, WRONG answer**, and the nine successes are what hide it.
               *
               * The attempt row is the liveness signal — a live child heartbeats, a dead one is `failed`
               * or `interrupted`. Re-read after an incomplete join because the child may have halted
               * while this call was subscribed.
               */
              const attempt = joined.completed
                ? undefined
                : yield* attempts.get(childID).pipe(Effect.orElseSucceed(() => undefined))
              const dead = joined.completed ? undefined : deadChildMessage(childID, attempt?.state)
              if (dead) return { completed: false, terminal: true, message: dead }
              if (!joined.completed)
                // ⚠️ Says what it MEANS, because the model reasons from this sentence. Measured
                // 2026-08-20: given a bare "Timed out waiting for session …", the model concluded
                // *"the child timed out because it cannot call exit"* — inventing a cause and
                // treating a still-running child as a dead one. A timeout here means "not finished
                // YET", and the recovery is one more call.
                return {
                  completed: false,
                  terminal: false,
                  message:
                    `Session ${childID} has not finished yet (waited ${Math.round(WAIT_TIMEOUT_MS / 60_000)} minutes). ` +
                    `It may still be working — this is not an error and does not mean it failed. ` +
                    `Call wait on ${childID} again to keep waiting, or carry on and join it later.`,
                }
              return {
                completed: true,
                terminal: true,
                message: `Session ${childID} completed. Result: ${joined.result ?? ""}`,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to wait for session." }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/wait",
  layer,
  deps: [ToolRegistry.node, SessionStore.node, SessionJoin.node, SessionExecutionAttempt.node],
})
