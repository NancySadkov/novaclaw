import { AdhocTools } from "@novaclaw/core/adhoc-tools"
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
    return handlers
      .handle(
        "list",
        Effect.fn("AdhocHttpApi.list")(function* (ctx) {
          return yield* Effect.promise(() => AdhocTools.listSessionRecipes(ctx.params.sessionID))
        }),
      )
      .handle(
        "discard",
        Effect.fn("AdhocHttpApi.discard")(function* (ctx) {
          const removed = yield* Effect.promise(() =>
            AdhocTools.removeSessionRecipe(ctx.params.sessionID, ctx.params.name),
          )
          return { removed }
        }),
      )
      .handle(
        "promote",
        Effect.fn("AdhocHttpApi.promote")(function* (ctx) {
          const recipes = yield* Effect.promise(() => AdhocTools.listSessionRecipes(ctx.params.sessionID))
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
