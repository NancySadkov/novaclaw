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
    description: "A short summary of what this session accomplished — handed to whoever spawned/awaits it.",
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
            "Request completion and submit this session's result for review. Use it when an autonomous " +
            "or delegated task is genuinely finished. The session ends only when the completion reviewer accepts it.",
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
