export * as JsTool from "./js"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { runJs, JS_TIMEOUT_MS } from "./js-run"

export const name = "js"

export const Input = Schema.Struct({
  code: Schema.String.annotate({
    description: "JavaScript to evaluate. The final expression's value is returned, plus any console.log output.",
  }),
})

export const Output = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  timedOut: Schema.optional(Schema.Boolean),
  logs: Schema.Array(Schema.String),
})
type ModelOutput = typeof Output.Encoded

/** Model-facing rendering: any console output, then either the value (`=> …`) or the error. */
export const toModelOutput = (output: ModelOutput): string => {
  const lines: string[] = []
  if (output.logs.length > 0) lines.push(output.logs.join("\n"))
  lines.push(output.ok ? `=> ${output.result ?? "undefined"}` : `Error: ${output.error ?? "unknown error"}`)
  return lines.join("\n")
}

/** A one-line, whitespace-flattened preview of the code for the permission prompt + saved rule. */
const preview = (code: string) => {
  const flat = code.replace(/\s+/g, " ").trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Evaluate a JavaScript snippet in a sandboxed scratchpad and get the result. Use it for exact arithmetic (native BigInt, or arbitrary-precision `Decimal` from decimal.js), the current date/time (`new Date()`), or to test a small algorithm — instead of computing it in your head. Returns the final expression's value plus any console.log output. Sandbox: standard JS + BigInt + Decimal + Date/Math/JSON only — NO filesystem, network, require, or process (use `bash` for those). Synchronous, hard 5-second timeout.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [preview(input.code)],
                save: ["*"],
                metadata: { code: input.code },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              return yield* Effect.sync(() => runJs(input.code, { timeoutMs: JS_TIMEOUT_MS }))
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/js",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
