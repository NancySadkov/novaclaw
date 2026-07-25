export * as WebSearchTool from "./websearch"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { WebSearch } from "../websearch/service"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"

// The `websearch` tool — one door, whatever is behind it (todo.md → "Web search: a built-in
// fallback so it just works for lay users").
//
// ⚠️ This REPLACED an inherited implementation that called the Exa and Parallel product backends
// with API keys. It contradicted the product on three counts: a paid API, a branded provider
// sitting in the kernel, and — worst for the person actually using NovaClaw — a fresh instance had
// NO working search while the tool's own description promised one. The engine now lives in
// core/websearch: the user's own SearXNG when they have one, an in-process metasearch over free
// engines when they don't, and a refusal that says why in offline/airgap mode.
//
// The input stays deliberately small. The old surface exposed livecrawl / type /
// contextMaxCharacters — vendor knobs a model had to guess at, which is the harness's job to
// decide, not the model's.

export const name = "websearch"

export const MAX_NUM_RESULTS = 20

export const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "What to search the web for" }),
  numResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_NUM_RESULTS))).annotate({
    description: `How many results to return (default 8, maximum ${MAX_NUM_RESULTS})`,
  }),
})

const Output = Schema.Struct({ ok: Schema.Boolean, message: Schema.String })
type Output = typeof Output.Type

/** Linearized results — one block per hit, the shape a model reads without parsing JSON. */
export const formatResults = (
  results: readonly { readonly title: string; readonly url: string; readonly snippet?: string; readonly engine: string }[],
): string =>
  results
    .map((result, index) => {
      const snippet = result.snippet === undefined || result.snippet.length === 0 ? "" : `\n   ${result.snippet.slice(0, 400)}`
      return `${index + 1}. ${result.title}\n   ${result.url} [${result.engine}]${snippet}`
    })
    .join("\n\n")

export const description =
  "Search the web for current information — anything past your knowledge cutoff, or that you should not guess at. " +
  "Uses the user's own SearXNG instance if they configured one, otherwise NovaClaw's built-in search. " +
  "Returns titles, URLs and short snippets; follow a URL with the webfetch tool when you need the page itself. " +
  "When a result points INTO a chat platform — a Telegram channel (t.me), a Discord announcement channel, a " +
  "subreddit — webfetch will usually return an empty JavaScript shell. Read those through the `messenger` tool " +
  "instead (the user's own connected account reading a public channel), which is a real source, not a dead end. " +
  `The current year is ${new Date().getFullYear()} — say so in queries about recent events. ` +
  "If search is unavailable the result says why in plain words (offline mode, every engine throttled) — pass that on rather than inventing an answer."

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const search = yield* WebSearch.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input) =>
            Effect.gen(function* () {
              const outcome = yield* search.search(input.query, { limit: input.numResults ?? 8 })
              if (!outcome.ok) return { ok: false, message: outcome.reason ?? "Search failed." } satisfies Output
              if (outcome.results.length === 0)
                return { ok: true, message: outcome.reason ?? "No results found for that query." } satisfies Output
              // A partial answer must never look complete — name the engine that dropped out.
              const degraded =
                outcome.degraded === undefined || outcome.degraded.length === 0
                  ? ""
                  : `\n\n(Partial: ${outcome.degraded.join(", ")} did not answer.)`
              return { ok: true, message: `${formatResults(outcome.results)}${degraded}` } satisfies Output
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/websearch", layer, deps: [ToolRegistry.node, WebSearch.node] })
