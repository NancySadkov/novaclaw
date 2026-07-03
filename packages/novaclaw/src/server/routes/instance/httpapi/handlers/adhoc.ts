import { AdhocTools } from "@novaclaw/core/adhoc-tools"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"

// 4E handlers — thin lowering onto the AdhocTools session store. Promote writes the
// PROJECT novaclaw.jsonc (the routed directory) with a comment-preserving jsonc patch.
export const adhocHandlers = HttpApiBuilder.group(InstanceHttpApi, "adhoc", (handlers) =>
  Effect.gen(function* () {
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
          const directory = (yield* InstanceState.context).directory
          const configPath = path.join(directory, "novaclaw.jsonc")
          const existing = yield* Effect.promise(() => fs.readFile(configPath, "utf8").catch(() => ""))
          const patched = AdhocTools.promoteRecipeToConfig(existing, recipe)
          yield* Effect.promise(() => fs.writeFile(configPath, patched, "utf8"))
          return { promoted: configPath }
        }),
      )
  }),
)
