export * as ResourceStatusTool from "./resource-status"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ResourcePressureContext } from "../resource-pressure-context"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "resource_status"

export const Input = Schema.Struct({})
export const Output = Schema.Struct({ lines: Schema.Array(Schema.String) })
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => output.lines.join("\n")

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const pressure = yield* ResourcePressureContext.Service
    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description:
              "Inspect this instance's live memory pressure and disk headroom. Use after a resource warning or cleanup to confirm whether pressure returned to normal.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: () => pressure.inspect().pipe(Effect.map((lines) => ({ lines: [...lines] }))),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/resource-status",
  layer,
  deps: [ToolRegistry.node, ResourcePressureContext.node],
})
