export * as WaitTool from "./wait"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// wait(sessionID) — join on a DIRECT child session's completion (architecture.md step 5), the
// complement to spawn/exit. The durable aggregate stream closes the read/subscribe race: it replays a
// completion that already landed, then tails future durable events without polling SQLite every two
// seconds. Blocking within the turn is intended (like bash's long timeouts).

export const name = "wait"
const WAIT_TIMEOUT = "2 minutes"

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
    const events = yield* EventV2.Service
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
          execute: (input, context) =>
            Effect.gen(function* () {
              const childID = SessionSchema.ID.make(input.sessionID)
              const child: SessionSchema.Info | undefined = yield* store.get(childID)
              if (!child || child.parentID !== context.sessionID) {
                return yield* Effect.fail(
                  new ToolFailure({ message: `Session ${childID} is not a direct child of this session.` }),
                )
              }

              const completed = yield* events.durable({ aggregateID: childID }).pipe(
                Stream.filter((event) => event.type === SessionEvent.Completed.type),
                Stream.map((event) => event as EventV2.Payload<typeof SessionEvent.Completed>),
                Stream.runHead,
                Effect.map(Option.getOrUndefined),
                Effect.timeoutOrElse({ duration: WAIT_TIMEOUT, orElse: () => Effect.succeed(undefined) }),
              )
              if (!completed) return { completed: false, message: `Timed out waiting for session ${childID}.` }
              const result = completed.data.result
              const rendered = typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result)
              return { completed: true, message: `Session ${childID} completed. Result: ${rendered}` }
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
  deps: [ToolRegistry.node, SessionStore.node, EventV2.node],
})
