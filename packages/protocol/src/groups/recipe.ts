import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SessionStrict } from "@novaclaw/schema/session-strict"
import { InvalidRequestError } from "../errors"

// Recipes — "source code for the AI era" (AGENTS.md). A recipe is a FOLDER on disk (recipe.md + assets);
// this is the surface the Recipes app drives. INSTANCE-GLOBAL: recipes belong to the install, not to a
// location. `run` is the interesting one — it copies the folder to a work dir and starts a session there,
// so cooking never mutates the recipe and the same recipe stays re-runnable forever.

const Recipe = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  prompt: Schema.String,
  assets: Schema.Array(Schema.String),
  builtin: Schema.Boolean,
  updatedAt: Schema.Number,
}).annotate({ identifier: "Recipe.Info" })

const SaveInput = Schema.Struct({
  slug: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  prompt: Schema.String,
}).annotate({ identifier: "Recipe.SaveInput" })

const RunResult = Schema.Struct({
  sessionID: Schema.String,
  /** Where it is cooking — the scratch folder by default, or whatever the caller chose. */
  directory: Schema.String,
  assets: Schema.Array(Schema.String),
}).annotate({ identifier: "Recipe.RunResult" })

export const RecipeGroup = HttpApiGroup.make("server.recipe")
  .add(
    HttpApiEndpoint.get("recipe.list", "/api/recipe", { success: Schema.Array(Recipe) }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.list",
        summary: "List recipes",
        description: "Every recipe on this install, name-sorted. `builtin` marks the ones NovaClaw shipped.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("recipe.get", "/api/recipe/:slug", {
      params: { slug: Schema.String },
      success: Recipe,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.recipe.get", summary: "Read one recipe" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("recipe.save", "/api/recipe", {
      payload: SaveInput,
      success: Recipe,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.save",
        summary: "Create or update a recipe",
        description: "Writes recipe.md. Omit `slug` to derive it from the name; pass it to update in place.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("recipe.duplicate", "/api/recipe/:slug/duplicate", {
      params: { slug: Schema.String },
      payload: Schema.Struct({}),
      success: Recipe,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.duplicate",
        summary: "Copy a recipe",
        description: "Copies the folder and its assets under a free slug — the 'make it mine' move for a shipped recipe.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("recipe.remove", "/api/recipe/:slug", {
      params: { slug: Schema.String },
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.recipe.remove", summary: "Delete a recipe and its assets" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("recipe.run", "/api/recipe/:slug/run", {
      params: { slug: Schema.String },
      payload: Schema.Struct({
        /** Where to cook. Omit for a fresh folder under the app-managed scratch workspace. */
        directory: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        agent: Schema.optional(Schema.String),
        /** Cook under the Strict harness (the composer's Strict switch, per cook). Omit to inherit the
         *  global Settings → Strict mode. Without this the ONLY way to cook in Strict was to flip the
         *  instance-global setting first: the cook's prompt is queued by this call, so a per-session
         *  override applied afterwards would race the drain. */
        strict: Schema.optional(SessionStrict.Override),
      }),
      success: RunResult,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.run",
        summary: "Cook a recipe",
        description:
          "Copies the recipe's assets into a work directory and starts a session there with the recipe as its prompt. The recipe itself is never modified, so it stays re-runnable.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "recipe", description: "Recipes — prompts + assets an agent cooks." }))
