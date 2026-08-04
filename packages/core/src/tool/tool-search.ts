export * as ToolSearchTool from "./tool-search"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { SessionOrigin } from "../session/origin"
import { ToolCatalogue } from "../tool-catalogue"
import { ToolCatalogueStore } from "../tool-catalogue-store"
import { RESULT_KIND } from "../tool-discovery"
import { ToolOutputStore } from "../tool-output-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "tool_search"

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description: "What capability you need, in plain language (for example: file a repository bug)",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))).annotate({
    description: "Maximum schemas to return (default 5, maximum 20)",
  }),
})

const Category = Schema.Struct({ server: Schema.String, categories: Schema.Array(Schema.String) })
const DiscoveredTool = Schema.Struct({
  name: Schema.String,
  server: Schema.String,
  description: Schema.String,
  input_schema: Schema.Unknown,
  arguments: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) })),
})
export const Output = Schema.Struct({
  kind: Schema.Literals([RESULT_KIND, "tool-search-empty", "tool-search-unavailable"]),
  query: Schema.String,
  message: Schema.String,
  tools: Schema.Array(DiscoveredTool),
  categories: Schema.Array(Category),
})
export type Output = typeof Output.Type

export const render = (output: Output) => {
  const { message, ...metadata } = output
  return `${message}\n\n${SessionOrigin.externalContentFrame("installed tool catalogue metadata")}${JSON.stringify(metadata, null, 2)}`
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const store = yield* ToolCatalogueStore.Service
    const outputStore = yield* ToolOutputStore.Service
    const location = yield* Location.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find installed deferred tools by capability. Returns complete callable input schemas as an append-only result. Call this when the category manifest suggests a capability but no resident tool fits; then call a returned tool by its exact name.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: render(output) }],
          execute: (input, context) => {
            const deferred = context.deferredTools ?? []
            const allowed = new Set(deferred.map((source) => source.definition.name))
            return Effect.gen(function* () {
              const limits = yield* outputStore.limits()
              return yield* store.search(location.directory, input.query, input.limit ?? 5, allowed).pipe(
                Effect.map((hits): Output => resultWithin(limits, input.query, deferred, hits)),
                Effect.catch((error) => {
                  const message = `tool_search is unavailable because its catalogue index failed: ${error instanceof Error ? error.message : String(error)}. Resident tools remain callable.`
                  return Effect.succeed({
                    kind: "tool-search-unavailable" as const,
                    query: input.query,
                    message,
                    tools: [],
                    categories: boundedCategories(input.query, deferred, limits, "tool-search-unavailable", message),
                  })
                }),
              )
            })
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/tool-search",
  layer,
  deps: [ToolRegistry.node, ToolCatalogueStore.node, ToolOutputStore.node, Location.node],
})

function resultWithin(
  limits: { readonly maxBytes: number; readonly maxLines: number },
  query: string,
  deferred: ReadonlyArray<ToolCatalogue.Source>,
  hits: ReadonlyArray<ToolCatalogueStore.SearchHit>,
): Output {
  const tools: Array<Output["tools"][number]> = []
  for (const hit of hits) {
    const candidate = {
      name: hit.name,
      server: hit.server,
      description: hit.description,
      input_schema: hit.inputSchema,
      arguments: hit.arguments,
    }
    const output = discoveryOutput(query, [...tools, candidate])
    if (fits(render(output), limits)) tools.push(candidate)
  }
  if (tools.length > 0) return discoveryOutput(query, tools)
  const kind = hits.length === 0 ? "tool-search-empty" : "tool-search-unavailable"
  const message =
    hits.length === 0
      ? "tool_search found no matching deferred tool. Try a category or capability named below; an empty result is not a callable schema."
      : "tool_search found a match, but its complete schema exceeds the configured tool-output limit. Narrow the query or raise that limit in Developer settings; no partial schema was disclosed."
  return {
    kind,
    query,
    message,
    tools: [],
    categories: boundedCategories(query, deferred, limits, kind, message),
  }
}

function discoveryOutput(query: string, tools: Output["tools"]): Output {
  return {
    kind: RESULT_KIND,
    query,
    message:
      `These ${tools.length} complete schema${tools.length === 1 ? " is" : "s are"} now callable for this session. ` +
      "Invoke one with the resident tool_call tool: pass its exact name as `name` and an object satisfying its input_schema as `input`.",
    tools,
    categories: [],
  }
}

function boundedCategories(
  query: string,
  deferred: ReadonlyArray<ToolCatalogue.Source>,
  limits: { readonly maxBytes: number; readonly maxLines: number },
  kind: "tool-search-empty" | "tool-search-unavailable",
  message: string,
): Output["categories"] {
  const categories: Array<Output["categories"][number]> = []
  for (const category of ToolCatalogue.manifest(deferred)) {
    const candidate: Output = {
      kind,
      query,
      message,
      tools: [],
      categories: [...categories, category],
    }
    if (!fits(render(candidate), limits)) break
    categories.push(category)
  }
  return categories
}

function fits(value: string, limits: { readonly maxBytes: number; readonly maxLines: number }) {
  return Buffer.byteLength(value, "utf-8") <= limits.maxBytes && value.split("\n").length <= limits.maxLines
}
