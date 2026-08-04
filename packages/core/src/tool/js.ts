export * as JsTool from "./js"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { HostExec } from "../host-exec"
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
          sideEffect: "external-unknown",
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
              // in-process sandbox was an escape). Its environment is composed by the ONE
              // host-execution gate (ruling 6, `src/host-exec.ts`) — the same module `tool/bash.ts`
              // and the jh/Strict runner consume — and it REPLACES the process environment rather
              // than extending it (`Env.inherit === false`):
              //  • `consent: "none"` — no human approved this snippet, so the gate composes the
              //    curated, secret-free base. Unlike a shell command, a calculator has no legitimate
              //    use for a provider key or a peer instance token, so there is nothing to trade off.
              //  • the OFF-C proxy-sink overlay from the shared Offline service (a no-op when
              //    offline mode is off), so an escaped child fails closed on WAN egress.
              //
              // ⚠️ HONEST LIMIT — the js child is NOT OS-confined, on any platform. Two reasons, and
              // neither is "the gate can't express it": `HostExec.plan` takes a `runtime-eval` shape
              // and returns a bwrap argv for it (`AgentJail.wrapArgv`). But (a) the runtime is
              // resolved by a PROBE inside `js-run.ts` (execPath vs bun vs node — the packaged
              // sidecar and the compiled CLI each need a different one), so the file to exec is not
              // known here; and (b) the sandbox argv masks `/home` and `/root` with tmpfs, which on
              // Linux hides a runtime installed under $HOME (`~/.bun/bin/bun`, a user-local node) and
              // would break the tool outright on the Spark. Confining it needs `js-run.ts` to hand
              // its resolved runtime back to the gate plus a ro-bind for that binary; until then this
              // call site gets the CREDENTIAL half only, and says so rather than implying a box that
              // isn't there. Note `decideBash`'s deny arm would also be wrong here: the snippet has
              // no host authority to withhold (bare V8 realm, no `process`/`require`/net/fs), so
              // denying would delete the calculator for every unattended session on every
              // backend-less host — i.e. all of Windows and macOS.
              const env = HostExec.childEnv({ consent: "none", egress: offline.egressEnv() }).vars
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
