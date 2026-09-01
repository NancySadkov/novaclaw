import path from "node:path"
import { AgentV2 } from "@novaclaw/core/agent"
import { Catalog } from "@novaclaw/core/catalog"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { Recipe } from "@novaclaw/core/recipe"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { RecipeVerify } from "@novaclaw/core/recipe-verify"
import { AbsolutePath } from "@novaclaw/core/schema"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { Scratch } from "@novaclaw/core/scratch"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { faultEvidence, sessionErrorDisplay } from "@novaclaw/core/session/session-error"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { RecipeApi, handlerLayer } from "../handler-api"

// Recipes handlers (AGENTS.md → *Recipes are source code for the AI era*). The store is plain async fns
// over the filesystem, so these mostly translate — except `run`, which is the feature:
//
//   check the recipe's `needs` against this host  →  materialize its assets into a WORK DIR
//     →  start a session there with the prompt
//
// The recipe folder itself is never touched, which is what keeps a recipe re-runnable forever. The work
// dir defaults to a per-recipe folder under the app-managed scratch workspace; a caller (the app's folder
// picker) may pass any directory instead, which is how a user "migrates" a cooked recipe somewhere
// permanent without us needing a migrate feature at all.

const builtins = { builtinSlugs: RecipeBuiltin.BUILTIN_SLUGS }

/** Recipe errors are user-facing text (bad name, unknown slug) — surface them as 400, not a 500. */
const badRequest = (error: unknown) =>
  new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) })

/** `"provider/model"` → a ref, or `undefined` when the caller said nothing usable. */
const modelRef = (spec: string | undefined): ModelV2.Ref | undefined => {
  if (!spec) return undefined
  const [providerID, ...rest] = spec.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return undefined
  return ModelV2.Ref.make({ id: ModelV2.ID.make(modelID), providerID: ProviderV2.ID.make(providerID) })
}

/** The wire spelling of a ref — the inverse of {@link modelRef}, and what a caller hands back to us. */
const modelSpec = (ref: { readonly providerID: string; readonly id: string }): string => `${ref.providerID}/${ref.id}`

/**
 * What the cook itself did — the half of a receipt the filesystem cannot answer.
 *
 * 🔴 **This is the fix for "an infrastructure failure reported as a subject failure"** (measured
 * 2026-08-18: six cooks wrote nothing because the model endpoint had died, and the receipt read *NOT
 * WORKING — about: this NovaClaw*). An empty folder only licenses a statement about the user's install if
 * the cook actually reached that install. So the cook's last assistant turn is read, its fault is
 * classified by the ONE classifier that owns the closed fault vocabulary
 * (`session-error.ts` → `faultEvidence`), and anything that is not evidence about this machine makes the
 * declarations unmeasurable rather than unmet.
 *
 * ⚠️ **It also answers WHICH MODEL ran**, and that is the better answer than any the caller has: the
 * assistant turn records the model the provider was actually called with, so a session whose model was
 * switched mid-cook, or one that never named a model and inherited the instance default, still classifies
 * correctly. `recipe.run` hands the resolved model back too, for a caller with no session in hand.
 *
 * ⚠️ **Never throws and never blocks the receipt.** A session that has been deleted, a decode failure, a
 * cook we cannot read: all of them answer `undefined`, which restores today's behaviour exactly. A
 * verifier that fell over because it could not read a session would be a health check that crashes —
 * which tells the user nothing at all.
 */
interface CookReading {
  readonly cook?: { readonly state: "ran" | "blocked" | "stopped"; readonly why?: string }
  readonly model?: string
}

const readCook = (sessions: SessionV2.Interface, sessionID: string): Effect.Effect<CookReading> =>
  Effect.gen(function* () {
    const messages = yield* sessions
      .messages({ sessionID: SessionSchema.ID.make(sessionID), order: "desc", limit: 40 })
      .pipe(Effect.catchCause((): Effect.Effect<SessionMessage.Message[]> => Effect.succeed([])))
    // Newest first, so the first assistant row IS the turn the cook ended on.
    const last = messages.find((message) => message.type === "assistant")
    if (last === undefined || last.type !== "assistant") return {}
    const model = modelSpec(last.model)
    // A turn with no fault RAN — that is the one path on which an absent file is the install's failure.
    if (last.error === undefined || last.error === null) return { cook: { state: "ran" as const }, model }
    const evidence = faultEvidence(last.error)
    // `sessionErrorDisplay` is the same chokepoint the transcript renders through, so the sentence on the
    // receipt is the sentence in the chat — already free of errnos and stack frames, and it NAMES the
    // endpoint, which is what makes "could not check" actionable instead of a shrug.
    const why = sessionErrorDisplay(last.error).headline
    if (evidence === "instrument") return { cook: { state: "blocked" as const, why }, model }
    if (evidence === "stopped") return { cook: { state: "stopped" as const, why }, model }
    // `subject` — a tool failed ON THIS MACHINE, which is exactly the question the health check asks.
    return { cook: { state: "ran" as const }, model }
  })

export const RecipeHandler = handlerLayer(
  HttpApiBuilder.group(RecipeApi, "server.recipe", (handlers) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      // ⚠️ Recipes are INSTANCE-GLOBAL (no `LocationMiddleware` on this group — see `handler-api.ts`),
      // but a model's capabilities live in the LOCATION-scoped catalog, so `yield* Catalog.Service` here
      // dies at runtime with "Service not found" while typechecking clean. Measured live 2026-08-18.
      // `pty-instance.ts` has the same shape and the same fix: hold the ONE server-wide map and provide
      // the location explicitly. The right location is the work directory itself — that is the location
      // the cook's own session was created at, so the capability read comes from the same catalog the
      // cook resolved its model through, rather than from some other location's view of it.
      const locations = yield* LocationServiceMap.Service
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
            if (recipe === undefined)
              return yield* new InvalidRequestError({ message: `No recipe named "${ctx.params.slug}"` })
            return recipe
          }),
        )
        .handle(
          "recipe.source",
          // The reader's endpoint — everything the Recipes app needs to show a recipe HONESTLY before
          // anyone presses Run, and the only place the author's own bytes leave the instance.
          //
          // ⚠️ Three separate reads rather than one, deliberately. `sourceOf` returning `undefined` means
          // WE COULD NOT READ THE FILE; `produces: []` means THE RECIPE NAMES NOTHING. Folding the second
          // into the first would let the app print "this recipe declares no artifacts" about a file
          // nobody opened, which is the fault described falsely (ruling 2) at the top of the UI.
          Effect.fn(function* (ctx) {
            const recipe = yield* Effect.promise(() => Recipe.read(ctx.params.slug, builtins))
            if (recipe === undefined)
              return yield* new InvalidRequestError({ message: `No recipe named "${ctx.params.slug}"` })
            const markdown = yield* Effect.promise(() => Recipe.sourceOf(recipe.slug))
            if (markdown === undefined)
              return yield* new InvalidRequestError({
                message: `I could not read “${recipe.name}”'s recipe.md — it may have been moved or locked while I looked.`,
              })
            // The SAME probe `recipe.run` refuses on, run early so the answer arrives before the cook
            // rather than after it. It resolves names on PATH and stats paths; it never runs a candidate,
            // and it can never install or grant anything (ruling 14).
            const needs = Recipe.checkNeeds(yield* Effect.promise(() => Recipe.needsOf(recipe.slug)))
            const produces = yield* Effect.promise(() => Recipe.producesOf(recipe.slug))
            const collection = RecipeBuiltin.collectionInfo(RecipeBuiltin.collectionOf(recipe.slug))
            return {
              slug: recipe.slug,
              name: recipe.name,
              markdown,
              needs: needs.map((check) => ({
                fact: check.fact,
                status: check.status,
                looked: check.looked,
                ...(check.found === undefined ? {} : { found: check.found }),
              })),
              produces,
              collection: { id: collection.id, title: collection.title, note: collection.note },
            }
          }),
        )
        .handle(
          "recipe.import",
          Effect.fn(function* (ctx) {
            return yield* Effect.tryPromise({
              try: () =>
                Recipe.importMarkdown(ctx.payload.markdown, {
                  ...(ctx.payload.slug ? { slug: ctx.payload.slug } : {}),
                }),
              catch: badRequest,
            })
          }),
        )
        .handle(
          "recipe.archive",
          Effect.fn(function* (ctx) {
            return yield* Effect.tryPromise({
              try: () => Recipe.exportArchive(ctx.params.slug),
              catch: badRequest,
            })
          }),
        )
        .handle(
          "recipe.archiveImport",
          Effect.fn(function* (ctx) {
            return yield* Effect.tryPromise({
              try: () =>
                Recipe.importArchive(ctx.payload, {
                  ...(ctx.query.slug ? { slug: ctx.query.slug } : {}),
                }),
              catch: badRequest,
            })
          }),
        )
        .handle(
          "recipe.update",
          // The PARTIAL edit — `Recipe.update`, which changes the lines it was asked about inside the
          // author's own bytes and copies every other byte forward untouched by construction.
          //
          // ⚠️ `undefined` and `null` mean different things on `description` and the difference is the
          // whole reason this endpoint is not `recipe.save`: absent = leave the author's line alone,
          // `null` = remove it. Spreading the optional fields conditionally is what keeps that true — an
          // unconditional `description: ctx.payload.description` would turn "did not mention it" into
          // "clear it" for every caller that only wanted to rename something.
          Effect.fn(function* (ctx) {
            return yield* Effect.tryPromise({
              try: () =>
                Recipe.update(
                  ctx.params.slug,
                  {
                    ...(ctx.payload.name === undefined ? {} : { name: ctx.payload.name }),
                    ...(ctx.payload.description === undefined ? {} : { description: ctx.payload.description }),
                    ...(ctx.payload.prompt === undefined ? {} : { prompt: ctx.payload.prompt }),
                    ...(ctx.payload.needs === undefined ? {} : { needs: ctx.payload.needs }),
                    ...(ctx.payload.produces === undefined ? {} : { produces: ctx.payload.produces }),
                  },
                  builtins,
                ),
              catch: badRequest,
            })
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
            if (recipe === undefined)
              return yield* new InvalidRequestError({ message: `No recipe named "${ctx.params.slug}"` })

            // ── THE DOOR: ruling 14's one machine-read field, checked before anything happens ──────────
            //
            // `needs` states host-capability facts ("a C compiler"). This is the only place that reads
            // them, and it runs BEFORE `Recipe.materialize` and BEFORE `sessions.create` deliberately:
            // everything below cooks with `permissionMode: "bypass"` in a freshly materialized folder, so
            // a recipe whose prerequisites are absent used to fail at a compile step — or after doing
            // partial work — rather than at the door, and left a scratch folder behind either way.
            // AGENTS.md calls the bundled set *the install's health check*; one that cannot say "you are
            // missing a C compiler" is failing its stated job.
            //
            // ⚠️ It REFUSES; it can never install, grant or run anything. Ruling 14's own reasoning: a
            // shared recipe is untrusted input the moment it lands, so it *may state what it needs and may
            // never state what it gets* — a `needs` entry that triggered a package install would be that
            // escalation wearing a different hat. The probe resolves names on PATH and stats paths, and
            // that is the whole of its authority.
            //
            // ⚠️ Ruling 2 is why this can only block on a fact we actually probed: an unrecognised `needs`
            // entry is `unknown`, never `absent`, so it NEVER blocks a cook — a false "you are missing gcc"
            // on a machine that has one is worse than no check. The refusal names what was looked for and
            // says how to override it, which is editing the recipe's own prose (there is no setting, by
            // design). It surfaces as the Recipes app's error toast, the same path an unknown slug takes.
            const unmet = Recipe.unmetMessage(
              recipe.name,
              Recipe.checkNeeds(yield* Effect.promise(() => Recipe.needsOf(recipe.slug))),
            )
            if (unmet !== undefined) return yield* new InvalidRequestError({ message: unmet })

            // Default work dir: a per-recipe folder under the scratch workspace, suffixed with the run time
            // so a second cook never collides with the first one's files.
            const now = yield* Clock.currentTimeMillis
            const directory =
              ctx.payload.directory?.trim() ||
              path.join(yield* Effect.promise(() => Scratch.ensure()), "recipes", `${recipe.slug}-${now}`)

            const materialized = yield* Effect.tryPromise({
              try: () => Recipe.materialize(recipe.slug, directory),
              catch: badRequest,
            })
            if (materialized.skipped.length > 0 || materialized.failed.length > 0) {
              const details = [
                ...(materialized.skipped.length > 0
                  ? [`Already there and left untouched: ${materialized.skipped.join(", ")}.`]
                  : []),
                ...(materialized.failed.length > 0 ? [`Could not copy: ${materialized.failed.join(", ")}.`] : []),
              ].join(" ")
              return yield* new InvalidRequestError({
                message:
                  `Not cooking “${recipe.name}”: its inputs were not copied completely. ${details} ` +
                  "I did not start the agent, so it cannot mistake a partial folder for the recipe. " +
                  "Choose an empty folder or repair the named recipe asset, then try again.",
              })
            }
            const assets = materialized.copied

            const model = modelRef(ctx.payload.model)

            /**
             * 🔴 **A cook belongs to the RECIPE service, and each run is one of its sub-sessions**
             * (owner, 2026-08-28: *"no ghosthouse architecture"*). It used to be created with no
             * agent at all — work nobody owned, which is exactly the shape the roster cannot show and
             * the user cannot point at.
             *
             * ⚠️ A CHILD, not a second root: cooks run many at a time and one live root per agent is
             * enforced in the database. The parent call is idempotent — `createSessionRecord` hands
             * back the service's existing chat rather than minting a sibling.
             */
            // ⚠️ `OwnerRequiredError` is unreachable on both creates below — each names
            // `RECIPE_ID` — so it is died on rather than widening this endpoint's error channel with
            // something no caller can act on. If either agent ever went away, this fails loudly at
            // the seam instead of returning a 400 that blames the user (NC-SEC-020).
            const recipeRoot = yield* sessions
              .create({
                agent: AgentV2.RECIPE_ID,
                location: { directory: AbsolutePath.make(directory) },
                title: "Recipes",
              })
              .pipe(Effect.orDie)
            const session = yield* sessions
              .create({
                agent: AgentV2.RECIPE_ID,
                parentID: recipeRoot.id,
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
              .pipe(Effect.orDie)
            // The session already exists by now, so a prompt failure must not read as "nothing happened":
            // report it with the session id so the user can open that chat and send the recipe themselves.
            yield* sessions.prompt({ sessionID: session.id, prompt: { text: recipe.prompt }, delivery: "queue" }).pipe(
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
            // What `recipe.verify` will judge this cook on, handed back with the session so a caller never
            // has to re-read the recipe to know what to check — and so a recipe that declares NOTHING is
            // visibly unjudgeable at the moment the cook starts, rather than looking like a pass later.
            const produces = yield* Effect.promise(() => Recipe.producesOf(recipe.slug))
            // ── WHICH MODEL WILL COOK, handed back with the session ───────────────────────────────────
            //
            // 🔴 Without this the NOT AVAILABLE arm could not fire from the app at all (measured
            // 2026-08-18). The Recipes app sends no `model`, so the session inherits the instance
            // default and NOTHING downstream knew what it was — a cook on a model that cannot call tools
            // read "Did not work · about: this NovaClaw", blaming the install for a model limit. The
            // arm existed and worked at this HTTP surface; the app simply never had a value to send.
            //
            // ⚠️ Resolved through the LOCATION-scoped catalog for the work directory — the same one the
            // cook's own session resolves through — for the reason spelled out above `locations`: a bare
            // `yield* Catalog.Service` on this instance-global group typechecks and dies at runtime.
            //
            // ⚠️ A failure here answers `undefined` and never fails the run. The caller then sends no
            // model to `verify`, which checks the files normally — an unresolvable model is `not-measured`
            // downstream, never `not-applicable`. A cook must never be lost to a catalog read.
            const cooking =
              model ??
              (yield* Catalog.Service.use((catalog) => catalog.model.default()).pipe(
                Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
                Effect.catchCause(() => Effect.succeed(undefined)),
              ))
            return {
              sessionID: session.id,
              directory,
              assets,
              produces,
              ...(cooking ? { model: modelSpec(cooking) } : {}),
            }
          }),
        )
        .handle(
          "recipe.verify",
          Effect.fn(function* (ctx) {
            // ── THE DETERMINISTIC SUCCESS ARTIFACT ────────────────────────────────────────────────────
            //
            // A cook's verdict was PROSE, so nothing mechanical could read its outcome
            // — and AGENTS.md's promise is that a user can tell *in one click* whether their NovaClaw
            // works. This reads the work dir and answers from the filesystem, so the answer does not
            // depend on what the model said about its own work. It runs nothing, writes nothing and is a
            // pure function of (folder, declarations, model): calling it twice gives the same receipt, and
            // calling it can never be the thing that broke the cook.
            const recipe = yield* Effect.promise(() => Recipe.read(ctx.params.slug, builtins))
            if (recipe === undefined)
              return yield* new InvalidRequestError({ message: `No recipe named "${ctx.params.slug}"` })
            const directory = ctx.payload.directory.trim()
            if (directory === "") return yield* new InvalidRequestError({ message: "Which folder did it cook in?" })

            // What the COOK did, when the caller named its session. Two facts the filesystem cannot
            // hold: whether the cook ever reached this machine, and which model actually ran.
            const reading = ctx.payload.sessionID
              ? yield* readCook(sessions, ctx.payload.sessionID)
              : ({} as CookReading)

            // ⚠️ A model we cannot resolve stays `undefined`, which makes the checks run normally and any
            // gap read as `not-measured`. Answering `not-applicable` here would claim "there was nothing
            // to measure" on the strength of a lookup miss — and `not-applicable` is the one reason that
            // tells a reader to STOP ASKING (`UnknownReason.STOPS_THE_READER`), so it has to be earned.
            //
            // An explicit payload `model` wins over the session's own record: a caller that knows better
            // (the live harness, a script cooking on a named model) must be able to say so.
            //
            // ⚠️ **And a catalog read that DIES must not take the receipt with it.** `recipe.run` guards
            // the identical call (`Effect.catchCause` → `undefined`, "a cook must never be lost to a
            // catalog read"); this one did not, so a location layer that failed to build — the very
            // "Service not found" shape measured on this group a day earlier — turned the health check
            // into a 500. `recipe-verify.ts` promises it "never throws: a health check that crashes has
            // told the user nothing", and that promise has to hold at the surface a person actually
            // presses, not only inside the function. Degrading to `undefined` is the answer the comment
            // above already prescribes: check the files normally, and any gap reads `not-measured`.
            const ref = modelRef(ctx.payload.model ?? reading.model)
            const info = ref
              ? yield* Catalog.Service.use((catalog) => catalog.model.get(ref.providerID, ref.id)).pipe(
                  Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
                  Effect.catchCause(() => Effect.succeed(undefined)),
                )
              : undefined

            const declares = yield* Effect.promise(() => Recipe.producesOf(recipe.slug))
            const receipt = yield* Effect.promise(() =>
              RecipeVerify.verify({
                recipeName: recipe.name,
                directory,
                declares,
                ...(info ? { model: { label: info.name || info.id, tools: info.capabilities.tools } } : {}),
                ...(reading.cook ? { cook: reading.cook } : {}),
              }),
            )
            return {
              slug: recipe.slug,
              name: recipe.name,
              directory: receipt.directory,
              verdict: receipt.verdict,
              checks: receipt.checks.map((check) => ({
                declared: check.declared,
                outcome: check.outcome,
                ...(check.reason ? { reason: check.reason } : {}),
                ...(check.looked ? { path: check.looked } : {}),
                checked: check.checked,
                ...(check.bytes === undefined ? {} : { bytes: check.bytes }),
              })),
              summary: RecipeVerify.summary(receipt),
              at: receipt.at,
              ...(receipt.cook ? { cookState: receipt.cook.state } : {}),
            }
          }),
        )
    }),
  ),
)
