export * as AdhocGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { mergeRecipes, type Recipe } from "../adhoc-tools"
import { Config } from "../config"
import { SystemContext } from "../system-context/index"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

// P4 (4C) — progressive disclosure: the prompt carries ONE LINE per recipe. The manual only
// enters context when the model pulls it via tool_manual.
const render = (tools: ReadonlyArray<Summary>) =>
  [
    "Ad-hoc tools are named recipes you run yourself through bash/curl (they are not tool-call",
    "functions). Before first use, call `tool_manual` with the tool's name to get its manual —",
    "the API shape and examples. You can also define new recipes for this session with",
    "`define_tool` when you work out a reusable command or API call.",
    ...(tools.length === 0
      ? ["No ad-hoc tools are currently configured."]
      : ["<adhoc_tools>", ...tools.map((tool) => `  ${tool.name} — ${tool.description}`), "</adhoc_tools>"]),
  ].join("\n")

export interface Interface {
  readonly load: () => Effect.Effect<SystemContext.SystemContext>
  /** Config-defined recipes (global ▷ project), merged by name — the non-session layers. */
  readonly configured: () => Effect.Effect<Recipe[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/AdhocGuidance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    // Config entries are ordered global -> project; merge per-recipe by name so a project
    // config can override or disable (enabled: false) a single global recipe.
    const configured = Effect.fn("AdhocGuidance.configured")(function* () {
      const entries = yield* config.entries()
      const layers = entries.flatMap((entry) =>
        entry.type === "document" && entry.info.adhoc_tools ? [entry.info.adhoc_tools] : [],
      )
      return mergeRecipes(...layers)
    })

    return Service.of({
      configured,
      load: Effect.fn("AdhocGuidance.load")(function* () {
        // NB session-DEFINED recipes are deliberately absent from the baseline (it is
        // per-session-epoch, initialized before any define_tool call) — define_tool's own
        // output tells the model its recipe is live, and tool_manual resolves both scopes.
        const available = (yield* configured()).map((recipe) => ({
          name: recipe.name,
          description: recipe.description,
        }))
        return SystemContext.make({
          key: SystemContext.Key.make("core/adhoc-tools"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available ad-hoc tools have changed. This list supersedes the previous one.",
              render(current),
            ].join("\n"),
          removed: () => "Ad-hoc tool guidance is no longer available. Do not use previously listed recipes.",
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
