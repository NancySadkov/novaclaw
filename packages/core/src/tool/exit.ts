export * as ExitTool from "./exit"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// exit(result) — an agent's REQUEST to return (architecture.md step 5), the complement to spawn.
// The runner presents the request and its evidence to the completion-review service. Only an accepted
// request publishes `session.next.completed`; a rejected request is the sole healthy-path automatic
// steer. Keeping publication out of this tool means a parent can never observe completion before the
// review that authorises it.

export const name = "exit"

export const Input = Schema.Struct({
  result: Schema.String.pipe(Schema.optional).annotate({
    description: "Your complete final answer to the user, or the result for the agent awaiting this task.",
  }),
})

const StructuredOutput = Schema.Struct({ completed: Schema.Boolean })
const Output = Schema.Struct({ ...StructuredOutput.fields, message: Schema.String })
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Give your final answer by calling this tool with the answer in `result`. This is the only way to " +
            "submit a final answer and request completion. Use it when an autonomous " +
            "or delegated task, or an interactive request, is genuinely finished. The session ends only when the completion reviewer accepts it.",
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({ completed: output.completed }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: () =>
            Effect.succeed({
              completed: false,
              message: "Completion requested; NovaClaw is reviewing the result before ending this session.",
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/exit", layer, deps: [ToolRegistry.node] })
