export * as WaitTool from "./wait"

import { ToolFailure } from "@novaclaw/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// wait(sessionID) — join on a child session's completion (architecture.md step 5), the complement to
// spawn/exit. Polls the child's `result` (set by exit() via the Completed event) until present or a
// timeout. Poll rather than push keeps it simple + robust. `result === undefined` means not-yet-exited
// (a never-exited row reads undefined; an exited session always has a string, "" if no summary), so the
// check is unambiguous. Blocking within the turn is intended (like bash's long timeouts).

export const name = "wait"
const POLL_INTERVAL_MS = 2000
const MAX_POLLS = 60 // ~2 minutes

export const Input = Schema.Struct({
  sessionID: Schema.String.annotate({ description: "The child session id to wait for (returned by a prior spawn)." }),
})

const StructuredOutput = Schema.Struct({ completed: Schema.Boolean })
const Output = Schema.Struct({ ...StructuredOutput.fields, message: Schema.String })
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const store = yield* SessionStore.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Block until a child session (spawned earlier) completes via exit(), then return its result. " +
            "Times out after ~2 minutes if the child has not completed.",
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({ completed: output.completed }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input) =>
            Effect.gen(function* () {
              const childID = SessionSchema.ID.make(input.sessionID)
              const poll = (remaining: number): Effect.Effect<Output> =>
                Effect.gen(function* () {
                  const child: SessionSchema.Info | undefined = yield* store.get(childID)
                  if (child?.result !== undefined) {
                    const result = typeof child.result === "string" ? child.result : JSON.stringify(child.result)
                    return { completed: true, message: `Session ${childID} completed. Result: ${result}` }
                  }
                  if (remaining <= 0) return { completed: false, message: `Timed out waiting for session ${childID}.` }
                  yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS))
                  return yield* poll(remaining - 1)
                })
              return yield* poll(MAX_POLLS)
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to wait for session." }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/wait", layer, deps: [ToolRegistry.node, SessionStore.node] })
