export * as ExitTool from "./exit"

import { ToolFailure } from "@novaclaw/llm"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { DateTime, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// exit(result) — an agent's "return" (architecture.md step 5), the complement to spawn. Publishes the
// durable `session.next.completed` event (result rides in it; the projector writes it to the session
// row for ps/list + for `wait`). Depends on EventV2 directly (a global, cycle-free — no seam needed,
// unlike spawn which needed create+enqueue). This is also what ENDS the self-drive loop: an
// auto-prompting/goal-oriented session keeps re-prompting itself at drain-end until the projected
// `result` lands on its row (runner/drive.ts reads `result !== undefined` as the terminal test).

export const name = "exit"

export const Input = Schema.Struct({
  result: Schema.String.pipe(Schema.optional).annotate({
    description: "A short summary of what this session accomplished — handed to whoever spawned/awaits it.",
  }),
})

const StructuredOutput = Schema.Struct({ completed: Schema.Boolean })
const Output = Schema.Struct({ ...StructuredOutput.fields, message: Schema.String })
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const events = yield* EventV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Mark this session complete and record its result (the session's 'return'). Use it when an " +
            "autonomous or delegated task is finished; whoever spawned this session (and calls wait) receives the result.",
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({ completed: output.completed }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const timestamp = yield* DateTime.now
              yield* events.publish(SessionEvent.Completed, {
                sessionID: context.sessionID,
                timestamp,
                result: input.result ?? "",
              })
              // K1: announce the terminal thread state so ps/task managers show "exited" live
              // (the durable record is the Completed event + the session row's result).
              yield* events.publish(SessionStatusEvent.Status, {
                sessionID: context.sessionID,
                status: { type: "exited" },
              })
              return { completed: true, message: "Session marked complete; result recorded." }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to mark session complete." }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/exit", layer, deps: [ToolRegistry.node, EventV2.node] })
