/**
 * P4 (4B) — `define_tool`: the model bootstraps its own capabilities. A recipe it works out
 * mid-session (an API endpoint + a curl that works) becomes a named, documented, reusable
 * tool — in a form the USER can read and later promote to project/global config. Writes are
 * SESSION-scoped only (never silently global) and permission-gated so the user stays in
 * control of what the model teaches itself.
 */
export * as DefineToolTool from "./define-tool"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { MAX_DESCRIPTION_CHARS, MAX_MANUAL_CHARS, saveSessionRecipe } from "../adhoc-tools"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "define_tool"

export const Input = Schema.Struct({
  name: Schema.String.annotate({
    description: "Tool name: a lowercase slug (a-z, 0-9, -, _), max 64 chars",
  }),
  description: Schema.String.annotate({
    description: `One-line description (max ${MAX_DESCRIPTION_CHARS} chars) — shown beside the name in tool listings`,
  }),
  manual: Schema.String.annotate({
    description: `The manual (max ${MAX_MANUAL_CHARS} chars): the API shape + 1-2 working curl/shell examples. NEVER embed secrets — a host/URL is fine, a password/API key is not.`,
  }),
})

export const Output = Schema.Struct({
  name: Schema.String,
  scope: Schema.Literal("session"),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `Defined ad-hoc tool "${output.name}" for THIS session. Recall its manual any time with tool_manual("${output.name}"). The user can promote it to project or global config to make it permanent.`

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Define (or update) a named ad-hoc tool recipe for this session: {name, description, manual}. Use it when you have worked out a reusable command or API call — the manual should carry the API shape and 1-2 working examples so you (or the user) can rerun it later via tool_manual. Session-scoped; never embed secrets in the manual.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [input.name.trim() || "(unnamed)"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool" as const,
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
                const recipe = yield* Effect.tryPromise({
                  try: () =>
                    saveSessionRecipe(context.sessionID, {
                      name: input.name,
                      description: input.description,
                      manual: input.manual,
                    }),
                  // normalizeRecipe throws model-legible validation messages — keep them intact.
                  catch: (error) =>
                    new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
                })
                return { name: recipe.name, scope: "session" as const }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({
                    message: `Unable to define tool: ${error instanceof Error ? error.message : String(error)}`,
                  })
                }),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/define-tool",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
