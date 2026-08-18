import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SessionStrict } from "@novaclaw/schema/session-strict"
import { UnknownReason } from "@novaclaw/schema/unknown-reason"
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
  /**
   * The artifacts this recipe says a finished cook leaves behind — what `recipe.verify` will check in
   * `directory` afterwards. Empty means the recipe declares no postcondition, so the only possible verdict
   * is "I cannot tell": a caller should say that rather than showing a success it did not earn.
   */
  produces: Schema.Array(Schema.String),
}).annotate({ identifier: "Recipe.RunResult" })

/**
 * One declared artifact, and what the HARNESS found when it looked — the deterministic success artifact
 * (`todo/recipes.md`). `outcome` is three-valued on purpose: `unknown` is not a failure, and `reason` says
 * which kind of not-knowing it is, in `@novaclaw/schema`'s shared vocabulary.
 */
const VerifyCheck = Schema.Struct({
  /** The recipe author's own words. */
  declared: Schema.String,
  outcome: Schema.Literals(["met", "unmet", "unknown"]),
  /** Present exactly when `outcome` is `unknown`. `not-applicable` is the NOT AVAILABLE arm. */
  reason: Schema.optional(UnknownReason.Reason),
  /** The path actually inspected, relative to the work dir. Absent means we did not look. */
  path: Schema.optional(Schema.String),
  /** What was ACTUALLY verified, in words — a weak claim must be readable as a weak claim. */
  checked: Schema.String,
  bytes: Schema.optional(Schema.Number),
}).annotate({ identifier: "Recipe.VerifyCheck" })

const VerifyResult = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  directory: Schema.String,
  /**
   * `working` · `not-working` (the instance) · `not-available` (the model could not, so this is not a
   * fault in the install) · `unknown` (we could not check — never a success).
   */
  verdict: Schema.Literals(["working", "not-working", "not-available", "unknown"]),
  checks: Schema.Array(VerifyCheck),
  /** The same receipt in one sentence, house style, safe to show a normal person. */
  summary: Schema.String,
  at: Schema.Number,
}).annotate({ identifier: "Recipe.VerifyResult" })

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
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.recipe.get", summary: "Read one recipe" })),
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
        description:
          "Copies the folder and its assets under a free slug — the 'make it mine' move for a shipped recipe.",
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
  .add(
    HttpApiEndpoint.post("recipe.verify", "/api/recipe/:slug/verify", {
      params: { slug: Schema.String },
      payload: Schema.Struct({
        /** The work dir a cook ran in — `recipe.run`'s `directory`. */
        directory: Schema.String,
        /**
         * The model that cooked, as `providerID/modelID`. Supply it and a model that cannot call tools
         * yields NOT AVAILABLE instead of NOT WORKING, because a model that cannot write a file has not
         * demonstrated anything about this install. Omit it and the files are simply checked — an
         * unresolvable model is `not-measured`, NEVER `not-applicable`, which would tell the reader to
         * stop asking a question that is still open.
         */
        model: Schema.optional(Schema.String),
      }),
      success: VerifyResult,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.verify",
        summary: "Check what a cook actually produced",
        description:
          "Reads the work directory and reports, per artifact the recipe declares, whether it is there and " +
          "whether it is the shape its name implies. Deterministic and read-only: the harness looks at the " +
          "filesystem, so the verdict does not depend on what the model said about its own work. Runs " +
          "nothing and writes nothing, and may be called as often as you like.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "recipe", description: "Recipes — prompts + assets an agent cooks." }))
