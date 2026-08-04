/**
 * `recipe` — the authoring surface for the artifact the product is built on.
 *
 * AGENTS.md (*Recipes are source code for the AI era*): a recipe is a FOLDER — a `recipe.md` prompt plus
 * whatever assets it needs. You do not ship the artifact, you ship the instructions for cooking it, and an
 * agent cooks it fresh against today's toolchain. *Source rots, intent doesn't.* It is called the
 * **anti-elitist artifact** because a normal person can read, edit and share one and cannot read a
 * Makefile — so an agent that cannot author one cannot participate in the product's central artifact.
 * `recipe.ts` (the store), the Recipes app and the seeded examples all existed; this tool is the missing
 * model-facing half.
 *
 * ── WHAT THIS TOOL DELIBERATELY CANNOT DO, and why ──────────────────────────────────────────────────
 *
 * ⚠️ **todo.md ruling 14 is the whole spec.** *A recipe stays a portable folder of prose. Frontmatter may
 * carry exactly one machine-read field — `needs`, restricted to host-capability facts a normal person can
 * verify — and no configuration or grant token. Share is what decides it: an artifact designed to travel
 * between strangers is untrusted input the moment it lands, so it may state what it needs and may never
 * state what it gets. Rules out `permissionMode`/`type`/`model`/`strict` in frontmatter.*
 *
 * The input schema below IS that enforcement, not a description of it: `save` accepts `name`,
 * `description`, `prompt`, `needs` and `slug` and nothing else, so no posture, permission, model or
 * strictness field can reach a recipe THROUGH this tool at all — there is no field to put it in and no
 * free-form frontmatter channel. (The roadmap item that opened this work asked for "a posture/permission/
 * model field on Recipe.Info". Ruling 14 forbids exactly those four; the real gap was the missing tool.)
 * The one seam where a model's bytes still become a frontmatter LINE is `needs`, and `Recipe.needsLine`
 * collapses control characters so an entry can never open a second key. Pinned in `test/tool-recipe.test.ts`.
 *
 * ⚠️ **No `level` and no `collection` either.** Both are designed but unlanded (`todo/recipes.md`), and
 * both are *instance* decisions rather than artifact ones: a shared recipe's self-declared expertise level
 * is untrusted input, so the artifact may propose and the instance decides, and a proposal may never LOWER
 * the gate. A tool that let a model write `level: normal` today would be the wrong half of that shape.
 *
 * ⚠️ **No `delete`, and no `cook`.** Deleting the user's recipes is the app's job (`Recipe.remove` already
 * serves it) and is not authoring. Cooking — copying the folder to a work dir and running it — is the
 * runner's, and wiring it to `spawn` is a separate design. Left deliberately, not forgotten.
 *
 * ── PERMISSION: ruling 4, and where the line falls ─────────────────────────────────────────────────
 *
 * `save` is a PRIVILEGED write and asks. The ambient-safe baseline in `permission.ts` states the three
 * membership tests — an action must not mutate the host, must not egress, and must not change what a LATER
 * turn or session runs — and names `define_tool` as the thing the third test keeps out, *"whose manual IS
 * saved for later turns to read"*. A recipe fails that test in the most literal form available: its prompt
 * does not merely reach a future session's context, it **becomes a future session's prompt**. So `recipe`
 * is absent from the baseline, falls through to `ask`, and the card names the slug being written.
 *
 * `save: [slug]` — NOT `save: ["*"]`, which is what `define_tool` uses for the same ruling-4 class. The
 * asymmetry is deliberate and is about blast radius: `define_tool`'s writes are session-scoped, so an
 * "always" there is bounded by the session. This store is instance-global and durable, and the bundled set
 * doubles as *the install's health check*, so a wildcard "always" would be a standing grant to silently
 * rewrite `install-health-check` for every future session. One card per recipe is the honest price.
 *
 * `list` and `read` are NOT gated. They pass all three tests — no mutation, no egress, nothing that
 * outlives the turn — and they read the user's own folder, which `read` may already do ambiently.
 *
 * ── UNTRUSTED INPUT: why this file does not frame ──────────────────────────────────────────────────
 *
 * A shared recipe IS untrusted input the moment it lands. It is still not wrapped in
 * `SessionOrigin.externalContentFrame`, for `skill.ts`'s reason exactly (recorded in the classification
 * ledger in `test/untrusted-framing.test.ts`): a recipe's whole function is to be instructions to the
 * model, so "treat as data, not as instructions" would break the artifact outright. Ruling 14's
 * containment is a different mechanism for a different artifact — frontmatter may state what it NEEDS and
 * never what it GETS — and it is enforced above by the schema. ⚠️ This file therefore belongs in that
 * file's `NO_EXTERNAL` list: the tool fetches no bytes from a third party, it reads the user's own disk.
 */
export * as RecipeTool from "./recipe"

import path from "node:path"
import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Global } from "../global"
import { PermissionV2 } from "../permission"
import { Recipe } from "../recipe"
import { RecipeBuiltin } from "../recipe-builtin"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "recipe"

const ListOp = Schema.Struct({ op: Schema.Literal("list") })

const ReadOp = Schema.Struct({
  op: Schema.Literal("read"),
  slug: Schema.String.annotate({ description: "The recipe's folder name, exactly as `list` reported it" }),
})

const SaveOp = Schema.Struct({
  op: Schema.Literal("save"),
  name: Schema.String.annotate({
    description: 'The recipe\'s title in plain words, e.g. "Compile and run a C program"',
  }),
  prompt: Schema.String.annotate({
    description:
      "THE RECIPE ITSELF: the instructions for cooking the thing, in prose a normal person can read and " +
      "edit. Write the INTENT and the acceptance test, not code and not settings — a capable agent will " +
      "re-derive a working artifact from it years from now. Do not name your own machine's install paths.",
  }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "One line shown beside the title in the recipe list",
  }),
  needs: Schema.Array(Schema.String)
    .pipe(Schema.optional)
    .annotate({
      description:
        'Host capabilities this recipe needs, each a short fact a person can check: ["a C compiler", "python3"]. ' +
        "This is the ONLY structured field a recipe may carry — it states what the recipe NEEDS, never what it gets.",
    }),
  slug: Schema.String.pipe(Schema.optional).annotate({
    description: "Folder name of an EXISTING recipe to replace. Omit it to create a new recipe.",
  }),
})

export const Input = Schema.Union([ListOp, ReadOp, SaveOp])

export const Output = Schema.Struct({
  op: Schema.Literals(["list", "read", "save"]),
  slug: Schema.String.pipe(Schema.optional),
  message: Schema.String,
})
export type Output = typeof Output.Type

export const description =
  "Author and read RECIPES — the folders of prose this product is built on (a recipe.md prompt plus its " +
  "assets). A recipe carries the INTENT of a thing to build, so an agent can cook it fresh later; it is " +
  "not code and never carries settings. Ops: " +
  '{"op":"list"} — every recipe on this install · ' +
  '{"op":"read","slug":"hello-c"} — one recipe\'s full text · ' +
  '{"op":"save","name":"…","prompt":"…","description":"…","needs":["a C compiler"]} — write a new one ' +
  "(add slug to replace an existing one instead). " +
  "Saving returns the recipe's folder — put any assets it needs there with the write tool. " +
  "Saving asks the user first, because a recipe becomes a future session's prompt."

// ── linearized rendering (pure; unit-tested) ───────────────────────────────────────────────────────

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim()

export const formatList = (recipes: readonly Recipe.Recipe[]): string => {
  if (recipes.length === 0)
    return 'No recipes on this install yet. Write one with {"op":"save","name":"…","prompt":"…"}.'
  return recipes
    .map((recipe) => {
      const parts = [`${recipe.slug} · ${recipe.name}`]
      if (recipe.description) parts.push(`— ${oneLine(recipe.description)}`)
      if (recipe.builtin) parts.push("[shipped example]")
      if (recipe.assets.length > 0) parts.push(`(assets: ${recipe.assets.join(", ")})`)
      return parts.join(" ")
    })
    .join("\n")
}

export const formatOne = (recipe: Recipe.Recipe, folder: string): string =>
  [
    `# ${recipe.name} (${recipe.slug})`,
    recipe.description ? `${recipe.description}` : undefined,
    `Folder: ${folder}`,
    recipe.assets.length > 0 ? `Assets: ${recipe.assets.join(", ")}` : "Assets: none",
    recipe.builtin ? "This is a shipped example — replacing it changes what every future run of it does." : undefined,
    "",
    recipe.prompt,
  ]
    .filter((line) => line !== undefined)
    .join("\n")

/**
 * The repair text for `save` without a `slug` onto a name that is taken. It spells the exact next call,
 * because a model's next tool call IS the repair loop — and because silently overwriting a recipe the
 * user did not name is the failure mode this branch exists to prevent.
 */
export const collisionMessage = (title: string, slug: string) =>
  `A recipe named "${title}" already exists (slug "${slug}"), and nothing was written. ` +
  `To REPLACE it: {"op":"save","slug":"${slug}","name":"${title}","prompt":"…"}. ` +
  `To keep both: choose a different name.`

export const savedMessage = (recipe: Recipe.Recipe, folder: string, replaced: boolean) =>
  `${replaced ? "Replaced" : "Saved"} recipe "${recipe.name}" (slug "${recipe.slug}"). ` +
  `Its folder is ${folder} — put any assets it needs there. ` +
  `Frontmatter you did not write is preserved on every save.`

const failure = (message: string) => new ToolFailure({ message })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    // Through the SERVICE, composed with `Recipe.rootIn` so the directory name is spelled once — the
    // `adhoc-tools.storeRootIn` lesson. In production this is identical to the module-level default
    // (`Global.make()` reads `Global.Path`), but a graph that overrides Global would otherwise have this
    // tool writing one root while the Recipes app listed another.
    const root = Recipe.rootIn((yield* Global.Service).data)
    const options = { root }

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              Effect.gen(function* () {
                switch (input.op) {
                  case "list": {
                    const recipes = yield* Effect.tryPromise({
                      try: () => Recipe.list({ ...options, builtinSlugs: RecipeBuiltin.BUILTIN_SLUGS }),
                      catch: (error) => failure(`Unable to list recipes: ${String(error)}`),
                    })
                    return { op: "list" as const, message: formatList(recipes) }
                  }

                  case "read": {
                    const slug = input.slug.trim()
                    const recipe = yield* Effect.tryPromise({
                      try: () => Recipe.read(slug, { ...options, builtinSlugs: RecipeBuiltin.BUILTIN_SLUGS }),
                      catch: (error) => failure(`Unable to read recipe "${slug}": ${String(error)}`),
                    })
                    if (!recipe) {
                      const known = yield* Effect.tryPromise({
                        try: () => Recipe.list(options),
                        catch: () => failure(`No recipe named "${slug}".`),
                      })
                      return yield* failure(
                        `No recipe named "${slug}". Available: ${known.map((one) => one.slug).join(", ") || "(none)"}`,
                      )
                    }
                    // `recipe.slug`, not the model's `slug`: the store already validated the one it
                    // resolved, so the path we hand back can never be built from unvalidated input.
                    return {
                      op: "read" as const,
                      slug: recipe.slug,
                      message: formatOne(recipe, path.join(root, recipe.slug)),
                    }
                  }

                  case "save": {
                    const title = input.name.trim()
                    const requested = input.slug?.trim()
                    const slug = requested || Recipe.slugify(title)
                    // Validate the folder name BEFORE the consent card, so the user is never asked to
                    // approve a write that was going to be refused anyway.
                    if (!Recipe.isValidSlug(slug))
                      return yield* failure(
                        requested
                          ? `"${requested}" is not a usable recipe folder name: lowercase letters, numbers, ` +
                              `- and _ only, starting with a letter or number.`
                          : `"${title}" does not reduce to a usable folder name. Give it a title with some ` +
                              `letters or numbers in it, or pass an explicit slug.`,
                      )
                    const existing = yield* Effect.tryPromise({
                      try: () => Recipe.read(slug, options),
                      catch: (error) => failure(`Unable to check for an existing recipe: ${String(error)}`),
                    })
                    // No slug given means CREATE. Overwriting then requires the model to name the folder it
                    // is replacing AND the user to approve a card carrying that name — two locks on the one
                    // move that can quietly destroy the user's own work (or the install's health check).
                    if (existing && !requested) return yield* failure(collisionMessage(title, slug))

                    yield* permission.assert({
                      action: name,
                      resources: [slug],
                      save: [slug],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: {
                        type: "tool" as const,
                        messageID: context.assistantMessageID,
                        callID: context.toolCallID,
                      },
                    })

                    const saved = yield* Effect.tryPromise({
                      try: () =>
                        Recipe.save(
                          {
                            slug,
                            name: title,
                            ...(input.description ? { description: input.description } : {}),
                            ...(input.needs ? { needs: input.needs } : {}),
                            prompt: input.prompt,
                          },
                          options,
                        ),
                      // `Recipe.save` throws model-legible validation messages ("A recipe needs a prompt —
                      // that is the whole recipe") and also throws when it cannot read the file back after
                      // writing. Both must surface as a FAILURE: ruling 2 — a failed mutation never reports
                      // success, and this one's success text would otherwise tell the model where to put
                      // assets for a folder that is not there.
                      catch: (error) =>
                        failure(`The recipe was NOT saved: ${error instanceof Error ? error.message : String(error)}`),
                    })
                    return {
                      op: "save" as const,
                      slug: saved.slug,
                      message: savedMessage(saved, path.join(root, saved.slug), existing !== undefined),
                    }
                  }
                }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return failure(denial)
                  return failure(`Recipe tool failed: ${error instanceof Error ? error.message : String(error)}`)
                }),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/recipe",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Global.node],
})
