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

/**
 * The resident description, exported so `tests/tool-discovery-smoke.ts` measures the text we
 * actually ship. It used to hold a COPY, which meant the harness could keep reporting a win for
 * wording that no longer existed — the failure mode where a green number describes the past.
 *
 * ⚠️ Every byte is RESIDENT: it rides in every prompt, and `location-layer.test.ts` ratchets the
 * resident tool schemas at 32,500 bytes. The first version of this fix blew that budget by 83.
 * Three claims are load-bearing per the measurement — the list is PARTIAL, what to give it, and
 * that it answers "what can you do". Keep those; re-measure discovery if you change them.
 */
export const DESCRIPTION =
  "Search ALL installed tools, including ones whose schemas are not in this request. Give a " +
  "plain-language capability (for example: read a sqlite database) and it returns their " +
  "complete callable schemas; call one by name. Use it whenever you are asked what you can " +
  "do — the tools listed here are not all the tools you have."

export const name = "tool_search"

/**
 * How many schemas a search returns when the caller does not say.
 *
 * ⚠️ **This was raised to 10 on 2026-08-11 and put back the same hour.** The raise was justified by a
 * battery that was never committed — reportedly 10/15 top-5 recall, with the five "misses" retrieved
 * at ranks 6–12 and cut by the cap. Rebuilding that battery as
 * `tests/tool-search-recall.ts` (15 plain-language requests, the shipped tokenizer, the shipped
 * OR-MATCH, the shipped bm25 ordering) reproduces **15/15 at top-5, every answer at rank 1–4**. It
 * does not reproduce the misses, so it does not support the raise — and it argues the other way,
 * because returning ten schemas when the answer sits at rank 1 spends tokens on every search to buy
 * nothing this battery can see.
 *
 * The lesson, worth more than the number: **a measurement whose inputs are not committed cannot be
 * re-run, and an uncommitted battery is a claim, not evidence.** The reconstruction may well be
 * easier than the original — but "my battery may be unrepresentative" is not evidence for a raise.
 * Five stands until a committed battery shows a miss past it.
 *
 * The cost analysis that survives: `resultWithin` appends candidates one at a time and stops at the
 * configured tool-output limit, so this bounds hits CONSIDERED, not bytes returned. A raise cannot
 * blow the output budget. It just cannot be shown to buy anything either.
 */
export const DEFAULT_LIMIT = 5

export const Input = Schema.Struct({
  query: Schema.String.annotate({
    description: "What capability you need, in plain language (for example: file a repository bug)",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))).annotate({
    description: `Maximum schemas to return (default ${DEFAULT_LIMIT}, maximum 20)`,
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
          // ⚠️ The previous wording was jargon AND circular: "Find installed DEFERRED tools ... call
          // this when the CATEGORY MANIFEST suggests a capability" — a model has no reason to map
          // "deferred" onto "tools you cannot see", and the category manifest only appears in this
          // tool's own OUTPUT, so the trigger it named was invisible until after the call. Holo-3.1,
          // asked for its full tool list, answered from the resident set and never searched (owner,
          // 2026-08-11). The system prompt now states the list is partial and gives the count; this
          // says what the tool does in the words a caller would use.
          description:
            // ⚠️ Every byte here is RESIDENT — it rides in every prompt, and `location-layer.test.ts`
            // ratchets the resident tool schemas at 32,500 bytes. The first wording of this fix blew
            // that budget by 83 bytes; this one keeps the three claims the measurement showed were
            // load-bearing (the list is partial · what to give it · that it answers "what can you
            // do") and drops the restatement. Re-measure discovery if you edit it.
            DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: render(output) }],
          execute: (input, context) => {
            const deferred = context.deferredTools ?? []
            const allowed = new Set(deferred.map((source) => source.definition.name))
            return Effect.gen(function* () {
              const limits = yield* outputStore.limits()
              return yield* store.search(location.directory, input.query, input.limit ?? DEFAULT_LIMIT, allowed).pipe(
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
  const candidates = hits.map((hit) => ({
    name: hit.name,
    server: hit.server,
    description: hit.description,
    input_schema: hit.inputSchema,
    arguments: hit.arguments,
  }))
  // 🔴 The answer is the longest RANKED PREFIX that fits, and it NAMES every hit past it.
  //
  // It used to be "keep whichever hits happen to fit": the loop tested each candidate and, on a miss,
  // carried on to the next SMALLER one without a word. So a lowered `tool_output` budget could drop
  // the TOP-ranked hit — the largest schema is usually the most capable tool — while the message went
  // on saying N complete schemas are now callable. A model that asked for exactly the right thing was
  // told that thing does not exist, and `ToolDiscovery.discovered` rebuilds the callable set purely
  // from the names inside a completed result, so the omission was permanent for the session. A false
  // negative is worse than an error: the model reasons from it and stops asking.
  //
  // Two things changed. The result is now a prefix, which is what this file's own `DEFAULT_LIMIT`
  // note already claimed ("appends candidates one at a time and stops at the configured limit") and
  // what keeps rank meaningful. And the omission is a REQUIRED argument of `discoveryOutput`, so a
  // success message cannot be constructed without accounting for what was withheld — the notice
  // cannot drift back out. Same rule this file already applies to categories and to the empty case,
  // and the same shape `unknown-tool.ts` uses for its truncated list.
  //
  // The notice is part of the rendered result, so a longer withheld list can push a prefix that
  // fitted while it was being assembled back over the limit. Testing each prefix WITH its own
  // complete notice, from longest down, is what makes the returned value always inside the budget.
  for (let count = candidates.length; count > 0; count--) {
    const output = discoveryOutput(
      query,
      candidates.slice(0, count),
      candidates.slice(count).map((candidate) => candidate.name),
    )
    if (fits(render(output), limits)) return output
  }
  const kind = hits.length === 0 ? "tool-search-empty" : "tool-search-unavailable"
  const build = (message: string): Output => ({
    kind,
    query,
    message,
    tools: [],
    categories: boundedCategories(query, deferred, limits, kind, message),
  })
  if (hits.length === 0)
    return build(
      "tool_search found no matching deferred tool. Try a category or capability named below; an empty result is not a callable schema.",
    )
  // Nothing fitted at all. The refusal was already honest; what it never did was say WHICH tool it
  // was refusing, so the model could not raise the limit for a named thing or ask for it another way.
  const named = build(
    `tool_search matched ${nameList(candidates.map((candidate) => candidate.name))}, but ${candidates.length === 1 ? "its complete schema exceeds" : "even the top-ranked one alone exceeds"} the configured tool-output limit. Narrow the query or raise that limit in Developer settings; no partial schema was disclosed.`,
  )
  if (fits(render(named), limits)) return named
  // Naming them did not fit either. Fall back to the wording that shipped before the names — a
  // refusal that itself overflows would be a fault described falsely.
  return build(
    "tool_search found a match, but its complete schema exceeds the configured tool-output limit. Narrow the query or raise that limit in Developer settings; no partial schema was disclosed.",
  )
}

/** Characters of withheld tool names a notice may spend before it says "and N more" — the same unit
 *  and the same reason as `UNKNOWN_TOOL_LIST_BUDGET`: an unbounded list is its own denial of service
 *  on a small model's context, and a truncated list that does not admit it omits something itself. */
const WITHHELD_NAME_BUDGET = 240

function nameList(names: ReadonlyArray<string>): string {
  const shown: Array<string> = []
  let budget = WITHHELD_NAME_BUDGET
  for (const name of names) {
    budget -= name.length + 2
    if (budget < 0 && shown.length > 0) break
    shown.push(name)
  }
  return shown.length === names.length
    ? shown.join(", ")
    : `${shown.join(", ")} and ${names.length - shown.length} more`
}

function discoveryOutput(query: string, tools: Output["tools"], omitted: ReadonlyArray<string>): Output {
  const partial =
    omitted.length === 0
      ? ""
      : ` This answer is PARTIAL: ${nameList(omitted)} also matched, ranked below the schemas above, and ${omitted.length === 1 ? "was" : "were"} withheld because the complete result would exceed the configured tool-output limit. ${omitted.length === 1 ? "It is" : "They are"} NOT callable and no partial schema was disclosed — narrow the query, lower \`limit\`, or raise the tool-output limit in Developer settings.`
  return {
    kind: RESULT_KIND,
    query,
    message:
      `These ${tools.length} complete schema${tools.length === 1 ? " is" : "s are"} now callable for this session. ` +
      "Invoke one with the resident tool_call tool: pass its exact name as `name` and an object satisfying its input_schema as `input`." +
      partial,
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
