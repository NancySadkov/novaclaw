import path from "node:path"
import { WorkProjects } from "@novaclaw/core/work-project/store"
import { deployRecipeProject } from "@novaclaw/core/work-project/deploy"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AgentRetire } from "@novaclaw/core/agent/retire"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import { AgentV2 } from "@novaclaw/core/agent"
import { Catalog } from "@novaclaw/core/catalog"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { Recipe } from "@novaclaw/core/recipe"
import * as RecipeDeployment from "@novaclaw/core/recipe-deployment"
import { Global } from "@novaclaw/core/global"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { RecipeVerify } from "@novaclaw/core/recipe-verify"
import { Pty } from "@novaclaw/core/pty"
import { PtyID } from "@novaclaw/core/pty/schema"
import { AbsolutePath } from "@novaclaw/core/schema"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { faultEvidence, sessionErrorDisplay } from "@novaclaw/core/session/session-error"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { RecipeApi, handlerLayer } from "../handler-api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"

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
const launchedTerminals = new Map<string, Set<PtyID>>()

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
      const projects = yield* WorkProjects.Service
      const cors = yield* CorsConfig
      const deployments = Effect.fn(function* () {
        const snapshot = yield* projects.execute({ op: "list" }).pipe(Effect.orDie)
        return yield* Effect.forEach(
          snapshot.projects.filter((project) => project.recipe && project.directory),
          (project) =>
            Effect.gen(function* () {
              const verified = project.phases.length > 0 && project.phases.every((phase) => phase.status === "complete")
              const launch = verified
                ? yield* Effect.promise(() => RecipeDeployment.readyLaunch(project.directory!))
                : undefined
              return {
                slug: project.id,
                projectID: project.id,
                directory: project.directory!,
                manager: project.recipe!.manager,
                name: project.name,
                description: project.objective,
                state: launch ? ("ready" as const) : ("deploying" as const),
                ...(launch ? { launch } : {}),
              }
            }),
        )
      })
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
          "recipe.archivePreview",
          Effect.fn(function* (ctx) {
            return yield* Effect.try({ try: () => Recipe.previewArchive(ctx.payload), catch: badRequest })
          }),
        )
        .handle(
          "recipe.deployedList",
          Effect.fn(function* () {
            return yield* deployments()
          }),
        )
        .handle(
          "recipe.undeploy",
          Effect.fn(function* (ctx) {
            const deployment = (yield* deployments()).find((entry) => entry.slug === ctx.params.slug)
            const terminals = launchedTerminals.get(ctx.params.slug)
            if (terminals) {
              for (const id of terminals) {
                yield* Pty.Service.use((pty) => pty.remove(id)).pipe(
                  Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(Global.Path.data) }))),
                  Effect.catch(() => Effect.void),
                )
              }
              launchedTerminals.delete(ctx.params.slug)
            }
            if (!deployment) return HttpApiSchema.NoContent.make()
            yield* projects
              .execute({ op: "pause", id: deployment.projectID, paused: true })
              .pipe(Effect.mapError(badRequest))
            const project = (yield* projects.execute({ op: "list" }).pipe(Effect.orDie)).projects.find(
              (entry) => entry.id === deployment.projectID,
            )!
            yield* Effect.gen(function* () {
              const { db } = yield* Database.Service
              const events = yield* EventV2.Service
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const agents = yield* AgentConfigStore.Service
              for (const officer of [...project.recipe!.officers].reverse()) {
                yield* AgentRetire.everything({ db, events, memory, agent: officer, at: Date.now() })
                yield* AgentConfigStore.retire(agents, officer)
              }
              yield* ConfigStoreWrite.refreshDomain("agents")
            }).pipe(
              Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(Global.Path.data) }))),
            )
            yield* Effect.tryPromise({
              try: () => RecipeDeployment.remove(project.id, deployment.directory),
              catch: badRequest,
            })
            yield* projects
              .execute({ op: "delete", id: project.id, revision: project.revision })
              .pipe(Effect.mapError(badRequest))
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "recipe.deployedLaunch",
          Effect.fn(function* (ctx) {
            const deployment = (yield* deployments()).find((entry) => entry.slug === ctx.params.slug)
            if (!deployment)
              return yield* new InvalidRequestError({ message: `No deployment named "${ctx.params.slug}"` })
            if (!deployment.launch) {
              const chat = yield* sessions
                .create({
                  agent: AgentV2.ID.make(deployment.manager),
                  location: { directory: AbsolutePath.make(deployment.directory) },
                })
                .pipe(Effect.mapError(badRequest))
              return { kind: "chat" as const, sessionID: chat.id }
            }
            if (deployment.launch.kind === "html") {
              const ticket = RecipeDeployment.issuePreviewTicket(deployment.slug)
              const relative = path
                .relative(deployment.directory, deployment.launch.path)
                .split(path.sep)
                .map(encodeURIComponent)
                .join("/")
              return { kind: "html" as const, url: `/api/recipe-preview/${deployment.slug}/${ticket}/${relative}` }
            }
            const directory = deployment.directory
            const terminal = yield* Pty.Service.use((pty) =>
              pty.create({
                command: deployment.launch!.path,
                cwd: directory,
                title: deployment.name,
              }),
            ).pipe(
              Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(Global.Path.data) }))),
              Effect.mapError(badRequest),
            )
            const active = launchedTerminals.get(deployment.slug) ?? new Set<PtyID>()
            active.add(terminal.id)
            launchedTerminals.set(deployment.slug, active)
            return { kind: "console" as const, ptyID: terminal.id }
          }),
        )
        .handleRaw("recipe.deployedFile", (ctx) =>
          Effect.gen(function* () {
            const pathname = new URL(ctx.request.url, "http://localhost").pathname
            const parts = /^\/api\/recipe-preview\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname)
            if (!parts) return HttpServerResponse.empty({ status: 404 })
            const slug = parts[1]!
            const ticket = parts[2]!
            if (!RecipeDeployment.verifyPreviewTicket(slug, ticket)) return HttpServerResponse.empty({ status: 403 })
            let relative: string
            try {
              relative = parts[3]!.split("/").map(decodeURIComponent).join("/")
            } catch {
              return HttpServerResponse.empty({ status: 404 })
            }
            const deployment = (yield* deployments()).find((entry) => entry.slug === slug)
            if (!deployment) return HttpServerResponse.empty({ status: 404 })
            const file = yield* Effect.promise(() =>
              RecipeDeployment.readPreviewFile(slug, relative, deployment.directory),
            )
            if (!file) return HttpServerResponse.empty({ status: 404 })
            let response = HttpServerResponse.uint8Array(file.bytes, { contentType: file.mime })
            response = HttpServerResponse.setHeader(response, "x-content-type-options", "nosniff")
            response = HttpServerResponse.setHeader(response, "cache-control", "no-store")
            let frameAncestors = "'self'"
            try {
              const origin = new URL(ctx.request.headers.referer ?? "").origin
              if (origin !== "null" && isAllowedRequestOrigin(origin, ctx.request.headers.host, cors))
                frameAncestors += ` ${origin}`
            } catch {}
            response = HttpServerResponse.setHeader(response, "vary", "Origin, Referer")
            response = HttpServerResponse.setHeader(
              response,
              "content-security-policy",
              `sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; frame-ancestors ${frameAncestors}`,
            )
            return response
          }),
        )
        .handle(
          "recipe.deploy",
          Effect.fn(function* (ctx) {
            const id = yield* deployRecipeProject({ slug: ctx.params.slug, ...ctx.payload }).pipe(
              Effect.mapError(badRequest),
            )
            return (yield* deployments()).find((entry) => entry.projectID === id)!
          }),
        )
        .handle(
          "recipe.replaceSource",
          Effect.fn(function* (ctx) {
            return yield* Effect.tryPromise({
              try: () => Recipe.replaceSource(ctx.params.slug, ctx.payload.source),
              catch: badRequest,
            })
          }),
        )
        .handle(
          "recipe.assets",
          Effect.fn(function* (ctx) {
            return yield* Effect.tryPromise({ try: () => Recipe.listAssets(ctx.params.slug), catch: badRequest })
          }),
        )
        .handle(
          "recipe.assetRead",
          Effect.fn(function* (ctx) {
            const bytes = yield* Effect.tryPromise({
              try: () => Recipe.readAsset(ctx.params.slug, ctx.query.path),
              catch: badRequest,
            })
            try {
              return {
                path: ctx.query.path,
                content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                encoding: "utf8" as const,
              }
            } catch {
              return {
                path: ctx.query.path,
                content: Buffer.from(bytes).toString("base64"),
                encoding: "base64" as const,
              }
            }
          }),
        )
        .handle(
          "recipe.assetWrite",
          Effect.fn(function* (ctx) {
            const { path: assetPath, content, encoding } = ctx.payload
            if (
              encoding === "base64" &&
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
            )
              return yield* new InvalidRequestError({ message: "Asset content is not valid base64" })
            const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8")
            yield* Effect.tryPromise({
              try: () => Recipe.writeAsset(ctx.params.slug, assetPath, bytes),
              catch: badRequest,
            })
            return { path: assetPath, content, encoding }
          }),
        )
        .handle(
          "recipe.assetRemove",
          Effect.fn(function* (ctx) {
            yield* Effect.tryPromise({
              try: () => Recipe.removeAsset(ctx.params.slug, ctx.query.path),
              catch: badRequest,
            })
            return HttpApiSchema.NoContent.make()
          }),
        )
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
            const source = yield* Effect.promise(() => Recipe.sourceOf(recipe.slug))
            if (source === undefined)
              return yield* new InvalidRequestError({
                message: `I could not read “${recipe.name}”'s recipe.json — it may have been moved or locked while I looked.`,
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
              source,
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
                Recipe.importSource(ctx.payload.source, {
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
                    ...(ctx.payload.officers === undefined ? {} : { officers: ctx.payload.officers }),
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
                  ...(ctx.payload.officers === undefined ? {} : { officers: ctx.payload.officers }),
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
