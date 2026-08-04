import { AdhocTools } from "@novaclaw/core/adhoc-tools"
import { Global } from "@novaclaw/core/global"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"

// 4E handlers — thin lowering onto the AdhocTools session store. Promote writes the
// instance-wide `adhoc_tools` SETTINGS STORE (config-sqlite: nothing reads a project
// jsonc at runtime anymore — the store IS the config; replace-by-name keeps it idempotent).
export const adhocHandlers = HttpApiBuilder.group(InstanceHttpApi, "adhoc", (handlers) =>
  Effect.gen(function* () {
    const settingsStore = yield* SettingsConfigStore.Service
    // The store root through the SERVICE (yielded ONCE while the handler layer builds, per this
    // directory's AGENTS.md), composed with `storeRootIn` so the directory name is spelled once —
    // the same resolution `core`'s `adhoc-tools/guidance.ts`, `tool/tool-manual.ts`,
    // `tool/define-tool.ts` and `session/spawner.ts` use. These routes are the USER's view of the
    // very store `define_tool` writes, so "which root" must have one answer per instance, not one
    // per module-load. Identical in production; the divergence would only appear where Global is
    // overridden, and this is the surface where it would read as data loss.
    const sessionStoreRoot = AdhocTools.storeRootIn((yield* Global.Service).data)
    return handlers
      .handle(
        "list",
        Effect.fn("AdhocHttpApi.list")(function* (ctx) {
          return yield* Effect.promise(() =>
            AdhocTools.listSessionRecipes(ctx.params.sessionID, { root: sessionStoreRoot }),
          )
        }),
      )
      .handle(
        "discard",
        Effect.fn("AdhocHttpApi.discard")(function* (ctx) {
          const removed = yield* Effect.promise(() =>
            AdhocTools.removeSessionRecipe(ctx.params.sessionID, ctx.params.name, { root: sessionStoreRoot }),
          )
          return { removed }
        }),
      )
      .handle(
        "promote",
        Effect.fn("AdhocHttpApi.promote")(function* (ctx) {
          const recipes = yield* Effect.promise(() =>
            AdhocTools.listSessionRecipes(ctx.params.sessionID, { root: sessionStoreRoot }),
          )
          const recipe = recipes.find((item) => item.name === ctx.params.name)
          if (!recipe)
            return yield* Effect.fail(
              notFound(`No recipe "${ctx.params.name}" defined in session ${ctx.params.sessionID}`),
            )
          const current = ((yield* settingsStore.all()).adhoc_tools ?? []) as Array<{ name: string }>
          const next = [
            ...current.filter((item) => item.name !== recipe.name),
            { name: recipe.name, description: recipe.description, manual: recipe.manual },
          ]
          yield* settingsStore.set("adhoc_tools", next)
          return { promoted: "adhoc_tools" }
        }),
      )
  }),
)
