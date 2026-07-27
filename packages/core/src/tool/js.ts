export * as JsTool from "./js"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentJail } from "../agent-jail"
import { makeLocationNode } from "../effect/app-node"
import { Offline } from "../offline"
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
    // OFF-C (layer 9): the same shared offline policy `tool/bash.ts` consumes, so the sandbox child
    // is composed against the SAME egress stance as every other child this instance starts.
    const offline = yield* Offline.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Evaluate a JavaScript snippet in a sandboxed scratchpad and get the result. Use it for exact arithmetic (native BigInt, or arbitrary-precision `Decimal` from decimal.js), the current date/time (`new Date()`), or to test a small algorithm — instead of computing it in your head. Returns the final expression's value plus any console.log output. Sandbox: standard JS + BigInt + Decimal + Date/Math/JSON only — NO filesystem, network, require, or process (use `bash` for those). Each call runs in a fresh isolated process and returns the final expression's value; pending promise work is not awaited. Hard 5-second timeout.",
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
              // The snippet runs OUT OF PROCESS in a bare vm realm (see `js-run.ts` for why the old
              // in-process sandbox was an escape). The child's environment is composed from the same
              // two helpers `tool/bash.ts` uses for a confined command, and it REPLACES the process
              // environment rather than extending it:
              //  • AgentJail.unattendedChildEnv — the curated, secret-free key set. Applied to EVERY
              //    js child, attended or not: unlike a shell command, a calculator has no legitimate
              //    use for a provider key or a peer instance token, so there is nothing to trade off.
              //  • Offline.egressEnv — the OFF-C proxy-sink overlay (a no-op when offline mode is
              //    off), so an escaped child fails closed on WAN egress like any other child.
              //
              // ⚠️ It deliberately does NOT go through `AgentJail.decideBash`, and that is the one
              // place this tool diverges from `tool/bash.ts`. `decideBash`'s deny arm exists because
              // an unattended chain must not get RAW HOST AUTHORITY without a sandbox to contain it;
              // it routes the agent to the path-gated native tools instead (`denyMessage`). After
              // this rewrite the js snippet has no host authority to withhold — it runs in a bare V8
              // realm with no `process`, no `require`, no network and no filesystem — so applying the
              // deny arm would buy nothing and would delete the calculator for every auto-prompting
              // and goal-oriented session on every host with no jail backend (i.e. all of Windows and
              // macOS today), which is where recipes and jh runs live. The credential half of the
              // jail's stance is what actually applies here, and it is applied unconditionally above.
              // The remaining gap is OS-level confinement of the child itself: `AgentJail.wrapArgs`
              // hardcodes `<shell> -c <command>` and so cannot express `<runtime> -e <program>`.
              // Generalising it belongs to the Wave-4 `host-exec.ts` extraction (ruling 6), which is
              // also where this call site should be re-pointed.
              const env = { ...AgentJail.unattendedChildEnv(process.env), ...(offline.egressEnv() ?? {}) }
              // `Effect.promise` aborts the signal on interruption, and `runJs` kills the child on
              // abort — a stopped session leaves no sandbox process behind.
              return yield* Effect.promise((signal) => runJs(input.code, { timeoutMs: JS_TIMEOUT_MS, env, signal }))
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
  deps: [ToolRegistry.node, PermissionV2.node, Offline.node],
})
