export * as ToolCallTool from "./tool-call"

import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "tool_call"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: ToolRegistry.withDeferredDispatcher(
          Tool.makeExternal({
            description:
              "Call a deferred tool whose complete schema was returned by tool_search. Pass the returned exact name and an input object satisfying its input_schema. Refuses tools that were not disclosed in this session.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Exact tool name returned by tool_search" },
                input: { type: "object", description: "Arguments satisfying that tool's returned input_schema" },
              },
              required: ["name", "input"],
              additionalProperties: false,
            },
            execute: (input, context) => {
              const value = record(input)
              const target = value.name
              const targetInput = record(value.input)
              if (typeof target !== "string" || !context.invokeDeferred)
                return Effect.fail(
                  new Tool.Failure({
                    message: "tool_call needs an exact name previously returned by tool_search and an input object.",
                  }),
                )
              return context.invokeDeferred(target, targetInput).pipe(
                Effect.map((output) => ({
                  structured: output.structured,
                  content: output.content.map((part) =>
                    part.type === "text"
                      ? part
                      : {
                          type: "file" as const,
                          data: part.uri.slice(part.uri.indexOf(",") + 1),
                          mime: part.mime,
                          name: part.name,
                        },
                  ),
                })),
              )
            },
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/tool-call", layer, deps: [ToolRegistry.node] })

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
