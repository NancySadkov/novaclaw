export * as AdhocGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Session } from "@novaclaw/schema/session"
import { listSessionRecipes, mergeRecipes, storeRootIn, type Recipe } from "../adhoc-tools"
import { Config } from "../config"
import { Global } from "../global"
import { SessionEffectiveConfig } from "../session/effective-config"
import { SystemContext } from "../system-context/index"
import { Log } from "@novaclaw/schema/log"

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
  /**
   * The prompt-visible recipe list for ONE session. `sessionID` is required on purpose: it is the
   * type that stops a caller reconstructing the config-only guidance the session scope was
   * invisible in (see the `load` body).
   */
  readonly load: (sessionID: Session.ID) => Effect.Effect<SystemContext.SystemContext>
  /** Config-defined recipes (global ▷ project), merged by name — the non-session layers. */
  readonly configured: () => Effect.Effect<Recipe[]>
  /**
   * Every recipe ONE session may use: the instance library, overlaid with the owning
   * officer's private recipes, overlaid with the session's own `define_tool` recipes.
   * Later layers win by name; `enabled: false` in a later layer hides an earlier one;
   * `globalTools: false` on the officer drops the library without touching its own.
   * This is the ONE recipe set — the prompt lists it and `tool_manual` resolves from it,
   * so the two cannot disagree about what exists.
   */
  readonly forSession: (sessionID: Session.ID) => Effect.Effect<Recipe[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/AdhocGuidance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    // Through the SERVICE, not the module-level `Global.Path`, so the session store's root is an
    // injectable seam (the same reason `AdhocTools.Options.root` exists). Identical in production —
    // `Global.make()` reads `Global.Path` — and `layerWith` has no production caller.
    const global = yield* Global.Service
    const sessionStoreRoot = storeRootIn(global.data)
    // THE config entry point, not a second agent lookup: the officer layer rides the same
    // resolution every turn already uses, so the prompt and `tool_manual` agree with the
    // runner about whose recipes these are by construction rather than by a parallel walk.
    const effective = yield* SessionEffectiveConfig.Service

    // Config entries are ordered global -> project; merge per-recipe by name so a project
    // config can override or disable (enabled: false) a single global recipe.
    const configured = Effect.fn("AdhocGuidance.configured")(function* () {
      const entries = yield* config.entries()
      const layers = entries.flatMap((entry) =>
        entry.type === "document" && entry.info.adhoc_tools ? [entry.info.adhoc_tools] : [],
      )
      return mergeRecipes(...layers)
    })

    const readSession = (sessionID: Session.ID) =>
      Effect.tryPromise(() => listSessionRecipes(sessionID, { root: sessionStoreRoot })).pipe(
        // listSessionRecipes already answers [] for every read/parse fault by design, so the only
        // reachable failure here is a malformed session id — a caller bug, not a fault of the
        // store. Name it and continue: a prompt missing its session recipes must not fail a turn.
        Effect.catch((cause) =>
          Log.event("tool.adhoc.read.failed", { "session.id": sessionID, "tool.cause": Log.fault(cause) }).pipe(
            Effect.as([] as Recipe[]),
          ),
        ),
      )

    const forSession = Effect.fn("AdhocGuidance.forSession")(function* (sessionID: Session.ID) {
      // The owning officer's private recipes, overlaid between the library and the session
      // layer: same by-name, later-wins merge as every other scope, so an officer recipe
      // overrides (or with `enabled: false`, hides) a library recipe of the same name, and a
      // session `define_tool` still wins over both. `globalTools: false` drops the library
      // without touching the officer's own.
      const resolved = yield* effective.resolve(sessionID)
      const library = resolved.globalTools === false ? [] : yield* configured()
      const officer: Recipe[] = (resolved.adhocTools ?? []).map((recipe) => ({
        name: recipe.name,
        description: recipe.description,
        manual: recipe.manual ?? "",
        ...(recipe.enabled === undefined ? {} : { enabled: recipe.enabled }),
      }))
      return mergeRecipes(library, officer, yield* readSession(sessionID))
    })

    return Service.of({
      configured,
      forSession,
      load: Effect.fn("AdhocGuidance.load")(function* (sessionID: Session.ID) {
        // Session-scope INCLUDED, replacing the earlier "the baseline is initialized before any
        // define_tool call, so the session layer is always empty there" reasoning. That premise
        // held for a session the user starts and is false for a session that is SPAWNED: 4D copies
        // the parent's recipes into the child (session/spawner.ts, messenger/gateway.ts) before the
        // child's first turn, so the child's very first baseline has a non-empty session layer —
        // the capability transferred and the child was never told it had it. Same shape for a
        // resumed session whose epoch is replaced by compaction. For define_tool the epoch's
        // reconcile pass now also emits the "tools have changed" update, which is additive to
        // define_tool's own output rather than a substitute for it.
        //
        // Merge order matches tool_manual's (library ▷ officer ▷ session, session wins)
        // via the same resolver, so the prompt lists exactly the set that tool resolves.
        const available = (yield* forSession(sessionID)).map((recipe) => ({
          name: recipe.name,
          description: recipe.description,
        }))
        return SystemContext.make({
          key: SystemContext.Key.make("core/adhoc-tools"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            ["The available ad-hoc tools have changed. This list supersedes the previous one.", render(current)].join(
              "\n",
            ),
          removed: () => "Ad-hoc tool guidance is no longer available. Do not use previously listed recipes.",
        })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Global.node, SessionEffectiveConfig.node],
})
