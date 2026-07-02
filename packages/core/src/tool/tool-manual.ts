/**
 * P4 (4B) — `tool_manual`: the on-demand half of progressive disclosure. The system prompt
 * lists ad-hoc recipes as one `name — description` line each; this tool returns the named
 * recipe's MANUAL (API shape + examples) so it only enters context when actually needed.
 * Read-only metadata — no permission gate (running the recipe through bash/curl is where
 * the 1I–1K gates apply).
 */
export * as ToolManualTool from "./tool-manual"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { listSessionRecipes, mergeRecipes } from "../adhoc-tools"
import { AdhocGuidance } from "../adhoc-tools/guidance"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "tool_manual"

export const Input = Schema.Struct({
  name: Schema.String.annotate({
    description: "The ad-hoc tool's name, exactly as listed in the system prompt",
  }),
})

export const Output = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  manual: Schema.String,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `# ${output.name} — ${output.description}\n\n${output.manual}\n\nRun the recipe through bash/curl as documented above.`

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const guidance = yield* AdhocGuidance.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Get the manual (API shape + usage examples) for a named ad-hoc tool from the system prompt's list, or one you defined with define_tool. Call this BEFORE first using a recipe; then run it via bash/curl.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const configured = yield* guidance.configured()
              const session = yield* Effect.tryPromise(() => listSessionRecipes(context.sessionID))
              const recipes = mergeRecipes(configured, session)
              const recipe = recipes.find((item) => item.name === input.name.trim())
              if (!recipe) {
                const names = recipes.map((item) => item.name).join(", ") || "(none)"
                return yield* new ToolFailure({
                  message: `No ad-hoc tool named "${input.name}". Available: ${names}`,
                })
              }
              return { name: recipe.name, description: recipe.description, manual: recipe.manual }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: `Unable to load the manual for ${input.name}: ${error instanceof Error ? error.message : String(error)}`,
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/tool-manual",
  layer,
  deps: [ToolRegistry.node, AdhocGuidance.node],
})
