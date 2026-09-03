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
  updatedAt: Schema.Finite,
}).annotate({ identifier: "Recipe.Info" })

const SaveInput = Schema.Struct({
  slug: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  prompt: Schema.String,
}).annotate({ identifier: "Recipe.SaveInput" })

/**
 * One host-capability fact a recipe declares, and what this machine actually said when we looked
 * (`core/src/recipe.ts` → the `needs` section).
 *
 * ⚠️ FOUR-valued, and neither not-knowing arm is `absent`. There is no probe for most facts a person can
 * write (`unknown`), and a probe that exists can itself fail — a locked file, an unreadable directory
 * (`unreadable`). A check that could not verify a claim says *"I could not check this"*; reporting either
 * as missing would be a fault described falsely, and neither ever blocks a cook.
 *
 * The two are kept apart because they prescribe different actions (`@novaclaw/schema/unknown-reason`):
 * `unknown` is *not-measured* — nothing for the user to do — while `unreadable` is *measurement-failed*
 * — a path on their machine they may well be able to fix.
 */
const NeedCheck = Schema.Struct({
  /** The author's own words, unchanged. */
  fact: Schema.String,
  status: Schema.Literals(["present", "absent", "unknown", "unreadable"]),
  /** Every candidate actually tried, in order, so the claim is checkable by hand. */
  looked: Schema.Array(Schema.String),
  /** What resolved, when the fact is met. */
  found: Schema.optional(Schema.String),
}).annotate({ identifier: "Recipe.NeedCheck" })

/**
 * A recipe as its author wrote it, plus the two things a reader needs before pressing Run: whether this
 * machine has what the recipe says it needs, and what a finished cook will be judged on.
 *
 * ⚠️ `markdown` is the FILE'S OWN BYTES, not a re-rendering. It powers reading and lossless text edits;
 * the archive endpoints are the complete share path because a recipe may also carry assets.
 */
const Source = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  markdown: Schema.String,
  needs: Schema.Array(NeedCheck),
  /** The `produces:` entries, in the order the author wrote them. Empty = nothing to check afterwards. */
  produces: Schema.Array(Schema.String),
  /** Which shelf it is on — decided by the BUILD (`RecipeBuiltin.collectionOf`), never by the file. */
  collection: Schema.Struct({
    id: Schema.Literals(["examples", "mine"]),
    title: Schema.String,
    note: Schema.String,
  }),
}).annotate({ identifier: "Recipe.Source" })

/**
 * A PARTIAL edit. Omit a field to leave it exactly as the author wrote it; `description: null` removes
 * that line; `needs: []` / `produces: []` clear theirs.
 *
 * ⚠️ Distinct from `SaveInput` on purpose. `save` takes a WHOLE recipe, so a caller that wants to add one
 * `produces:` line has to resend the prompt — and a caller retyping prose it did not author is exactly
 * the lossy rewrite `Recipe.edit` exists to prevent, arriving through the front door.
 */
const UpdateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  prompt: Schema.optional(Schema.String),
  needs: Schema.optional(Schema.Array(Schema.String)),
  produces: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Recipe.UpdateInput" })

/** A `recipe.md` from somewhere else, stored byte for byte. */
const ImportInput = Schema.Struct({
  markdown: Schema.String,
  /** Preferred folder name. Omitted, it is derived from the file's own `name:`; taken, the next free one. */
  slug: Schema.optional(Schema.String),
}).annotate({ identifier: "Recipe.ImportInput" })

/** A complete recipe folder on the wire, as actual ZIP bytes rather than a JSON wrapper. */
const Archive = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/zip" }))

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
  /**
   * The model this cook will actually run on, as `providerID/modelID` — the caller's own `model` when
   * they named one, otherwise the instance's default, resolved HERE so the caller does not have to.
   *
   * ⚠️ **Without this the NOT AVAILABLE arm was structurally unreachable from the app** (measured
   * 2026-08-18). The Recipes app sends no `model` on run, kept none, and passed none to `recipe.verify`
   * — so on an instance whose only model cannot call tools, a cook that could never have written a file
   * reported *"Did not work · about: this NovaClaw"*. Both arms worked at this HTTP surface; nothing ever
   * sent one. Handing the resolved model back with the session is what closes that loop.
   *
   * Optional because an instance with no usable model at all must say nothing rather than guess: an
   * unresolvable model is `not-measured` downstream, never `not-applicable`.
   */
  model: Schema.optional(Schema.String),
}).annotate({ identifier: "Recipe.RunResult" })

/**
 * One declared artifact, and what the HARNESS found when it looked — the deterministic success artifact
 * for a cook. `outcome` is three-valued on purpose: `unknown` is not a failure, and `reason` says
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
  bytes: Schema.optional(Schema.Finite),
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
  at: Schema.Finite,
  /**
   * What the COOK did, when a `sessionID` was supplied and we could read it.
   *
   * 🔴 `blocked` is the field that stops a dead endpoint reading as a broken install. An empty folder
   * only means the install failed if the cook actually reached this machine; a cook that died on a
   * transport fault produced no evidence about the host at all, so every `unmet` row is re-filed as
   * `unknown`/`measurement-failed` and the verdict can no longer be `not-working`. `stopped` is the same
   * argument for a person pressing stop (`incomplete` — a floor, not an outcome).
   *
   * Absent = we were not told, which is NOT the same as `ran` and must not be rendered as it.
   */
  cookState: Schema.optional(Schema.Literals(["ran", "blocked", "stopped"])),
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
    HttpApiEndpoint.get("recipe.source", "/api/recipe/:slug/source", {
      params: { slug: Schema.String },
      success: Source,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.source",
        summary: "Read a recipe's file, and what it needs and produces",
        description:
          "The bytes of recipe.md exactly as they are on disk — the readable part of the folder — plus the " +
          "host-capability facts it declares checked against THIS machine, the artifacts a finished cook " +
          "should leave, and the shelf it is on. Read-only: the capability probe resolves names on PATH " +
          "and stats paths, and never runs a candidate.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("recipe.import", "/api/recipe/import", {
      payload: ImportInput,
      success: Recipe,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.import",
        summary: "Store pasted recipe markdown without assets",
        description:
          "Writes the supplied file byte for byte under a free slug — never overwriting an existing " +
          "recipe. This paste convenience is explicitly asset-free; use the ZIP import for a complete folder.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("recipe.archive", "/api/recipe/:slug/archive", {
      params: { slug: Schema.String },
      success: Archive,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.archive",
        summary: "Export a complete recipe folder",
        description: "Returns a standard ZIP containing recipe.md and every nested binary or text asset.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("recipe.archiveImport", "/api/recipe/archive", {
      query: { slug: Schema.optional(Schema.String) },
      payload: Archive,
      success: Recipe,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.archiveImport",
        summary: "Import a complete recipe folder",
        description:
          "Validates a bounded standard ZIP, reserves a free slug, and commits recipe.md plus its asset tree atomically.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("recipe.update", "/api/recipe/:slug", {
      params: { slug: Schema.String },
      payload: UpdateInput,
      success: Recipe,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.recipe.update",
        summary: "Change some of a recipe's fields and nothing else",
        description:
          "Edits the requested lines inside the author's own bytes: line endings, a BOM, unknown " +
          "frontmatter keys, key order and the trailing newline all survive. Use this rather than a save " +
          "when you are changing one field — a save takes the whole recipe.",
      }),
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
        /**
         * The cook's own session (`recipe.run`'s `sessionID`). Supply it and the receipt learns two
         * things it cannot get from the filesystem:
         *
         *  1. **Whether the cook ever reached this machine.** A turn that died on a transport fault
         *     wrote nothing and proved nothing, so its empty folder is `unknown`, never `not-working` —
         *     the fault is described falsely otherwise (ruling 2), and it was: measured 2026-08-18.
         *  2. **Which model ACTUALLY ran**, from the assistant turn's own record, which beats anything a
         *     caller can remember — a session whose model was switched mid-cook still answers correctly.
         *     An explicit `model` above still wins, so a caller can override.
         *
         * Omit it and nothing changes: the folder is checked exactly as before.
         */
        sessionID: Schema.optional(Schema.String),
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
