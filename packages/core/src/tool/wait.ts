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
 * ⚠️ **Only a state that CANNOT recover counts as dead.** `recovering` and `paused` are still
 * alive, and `starting`/`busy` obviously so; calling any of those dead would send the parent to
 * duplicate work a live child is doing — the opposite error, and an expensive one on a device
 * this fan-out is meant to saturate. An ABSENT attempt row is also not dead: it means the child
 * has not started yet, or the row was pruned.
 */
export const deadChildMessage = (childID: string, state: string | undefined): string | undefined => {
  if (state !== "failed" && state !== "interrupted") return undefined
  return (
    `Session ${childID} DID NOT FINISH: its execution ${state === "failed" ? "failed" : "was interrupted"}. ` +
    `It is not still working and waiting again will not help. Its share of the work was NOT done — ` +
    `re-issue that slice yourself, or spawn a replacement for it, before you treat the set as complete.`
  )
}

export const name = "wait"
/**
 * Milliseconds, because `SessionJoin` crosses the worker protocol and a Duration does not.
 *
 * 🔴 **Raised from 2 minutes on 2026-08-20, because 2 minutes is shorter than one child's TURN.**
 * Measured: a child asked only to reply "BANANA" settled **121.7 seconds** after `wait` started —
 * and `wait` had given up 1.6 seconds earlier. Nothing was wrong; parent and child share one local
 * model server, so the child's single inference queued behind the parent's own. A join whose timeout
 * is the same order as one inference reports a false negative on a healthy run, which is exactly
 * what a supervisor must never do.
 *
 * ⚠️ The timeout is still an ANSWER, not a failure — it must stay bounded so a wedged child cannot
 * hold a parent forever. Ten minutes is well past a slow local turn and still well short of a hang.
 */
const WAIT_TIMEOUT_MS = 10 * 60_000

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
              const childID = SessionSchema.ID.make(input.sessionID)
              const child: SessionSchema.Info | undefined = yield* store.get(childID)
              if (!child || child.parentID !== context.sessionID) {
                return yield* Effect.fail(
                  new ToolFailure({ message: `Session ${childID} is not a direct child of this session.` }),
                )
              }

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
               * or `interrupted`. Consulted only when the join did NOT complete, so the happy path is
               * unchanged and costs nothing.
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
