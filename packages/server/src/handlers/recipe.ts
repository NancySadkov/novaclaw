import path from "node:path"
import { AgentV2 } from "@novaclaw/core/agent"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { Recipe } from "@novaclaw/core/recipe"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Scratch } from "@novaclaw/core/scratch"
import { SessionV2 } from "@novaclaw/core/session"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

// Recipes handlers (AGENTS.md → *Recipes are source code for the AI era*). The store is plain async fns
// over the filesystem, so these mostly translate — except `run`, which is the feature:
//
//   materialize the recipe's assets into a WORK DIR  →  start a session there with the prompt
//
// The recipe folder itself is never touched, which is what keeps a recipe re-runnable forever. The work
// dir defaults to a per-recipe folder under the app-managed scratch workspace; a caller (the app's folder
// picker) may pass any directory instead, which is how a user "migrates" a cooked recipe somewhere
// permanent without us needing a migrate feature at all.

const builtins = { builtinSlugs: RecipeBuiltin.BUILTIN_SLUGS }

/** Recipe errors are user-facing text (bad name, unknown slug) — surface them as 400, not a 500. */
const badRequest = (error: unknown) =>
  new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) })

export const RecipeHandler = HttpApiBuilder.group(Api, "server.recipe", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    return handlers
      .handle(
        "recipe.list",
        Effect.fn(function* () {
          return yield* Effect.promise(() => Recipe.list(builtins))
        }),
      )
      .handle(
        "recipe.get",
        Effect.fn(function* (ctx) {
          const recipe = yield* Effect.promise(() => Recipe.read(ctx.params.slug, builtins))
          if (recipe === undefined) return yield* new InvalidRequestError({ message: `No recipe named "${ctx.params.slug}"` })
          return recipe
        }),
      )
      .handle(
        "recipe.save",
        Effect.fn(function* (ctx) {
          return yield* Effect.tryPromise({
            try: () =>
              Recipe.save({
                ...(ctx.payload.slug ? { slug: ctx.payload.slug } : {}),
                name: ctx.payload.name,
                ...(ctx.payload.description ? { description: ctx.payload.description } : {}),
                prompt: ctx.payload.prompt,
              }),
            catch: badRequest,
          })
        }),
      )
      .handle(
        "recipe.duplicate",
        Effect.fn(function* (ctx) {
          return yield* Effect.tryPromise({ try: () => Recipe.duplicate(ctx.params.slug), catch: badRequest })
        }),
      )
      .handle(
        "recipe.remove",
        Effect.fn(function* (ctx) {
          yield* Effect.tryPromise({ try: () => Recipe.remove(ctx.params.slug), catch: badRequest }).pipe(
            Effect.catch(() => Effect.void),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "recipe.run",
        Effect.fn(function* (ctx) {
          const recipe = yield* Effect.promise(() => Recipe.read(ctx.params.slug, builtins))
          if (recipe === undefined) return yield* new InvalidRequestError({ message: `No recipe named "${ctx.params.slug}"` })

          // Default work dir: a per-recipe folder under the scratch workspace, suffixed with the run time
          // so a second cook never collides with the first one's files.
          const now = yield* Clock.currentTimeMillis
          const directory =
            ctx.payload.directory?.trim() ||
            path.join(yield* Effect.promise(() => Scratch.ensure()), "recipes", `${recipe.slug}-${now}`)

          const assets = yield* Effect.tryPromise({
            try: () => Recipe.materialize(recipe.slug, directory),
            catch: badRequest,
          })

          let model: ModelV2.Ref | undefined
          if (ctx.payload.model) {
            const [providerID, ...rest] = ctx.payload.model.split("/")
            const modelID = rest.join("/")
            if (providerID && modelID)
              model = ModelV2.Ref.make({ id: ModelV2.ID.make(modelID), providerID: ProviderV2.ID.make(providerID) })
          }

          const session = yield* sessions.create({
            location: { directory: AbsolutePath.make(directory) },
            title: recipe.name,
            // Cooking is a "go and do it" action, not a conversation: the user picked a recipe and a folder
            // and expects work to happen. Left interactive+ASK it landed them in a chat full of pending
            // permission prompts for a task they had already approved by pressing Run — `bypass` is what
            // fixed that, and it is write access to THIS FOLDER only (writing outside stays guarded
            // independently of the mode). The work folder is freshly materialized for this cook, so "free
            // inside it" is the whole intent.
            //
            // ⚠️ The TYPE is `interactive` deliberately, and reverting it to `goal-oriented` breaks
            // cooking on Windows. Attendance is what the Agent Jail keys on: an UNATTENDED chain root
            // requires sandbox confinement for raw shell execution, and no sandbox backend exists on
            // Windows/macOS yet — so `bash` is DENIED outright there. Measured 2026-07-26: every one of
            // the seven shipped recipes lost its shell on Windows; `hello-c` and `pi-100-machin` — the
            // pair AGENTS.md calls the install health check — wrote correct C they could never compile,
            // and `install-health-check` duly reported the install as broken. And the attendance claim is
            // simply TRUE: the user pressed Run and is looking at the chat, so an ask (only reachable for
            // out-of-folder work) reaches a human who can answer it.
            type: "interactive",
            permissionMode: "bypass",
            ...(ctx.payload.strict ? { strict: ctx.payload.strict } : {}),
            ...(model ? { model } : {}),
            ...(ctx.payload.agent ? { agent: AgentV2.ID.make(ctx.payload.agent) } : {}),
            // Traceable back to what was cooked, and which copy.
            metadata: { recipeSlug: recipe.slug, recipeName: recipe.name },
          })
          // The session already exists by now, so a prompt failure must not read as "nothing happened":
          // report it with the session id so the user can open that chat and send the recipe themselves.
          yield* sessions
            .prompt({ sessionID: session.id, prompt: { text: recipe.prompt }, delivery: "queue" })
            .pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new InvalidRequestError({
                    message:
                      `Started the session for "${recipe.name}" and copied its files to ${directory}, but could not ` +
                      `queue the prompt (${error._tag}). Open that chat and send the recipe text to cook it.`,
                  }),
                ),
              ),
            )
          return { sessionID: session.id, directory, assets }
        }),
      )
  }),
)
