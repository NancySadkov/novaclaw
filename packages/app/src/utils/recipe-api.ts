import type { ServerConnection } from "@/context/server"
import { instanceFetch, instanceFetchResponse } from "@/utils/instance-fetch"

// Raw-fetch client for /api/recipe. Recipes are instance-global, so the connection (base URL +
// creds) is the only routing needed — no `directory`.
//
// ⚠️ Base URL, auth, and fault decoding live in `utils/instance-fetch.ts`. This file's old
// hand-rolled decoder preferred the server's `message` over a bare status ("a bad name / unknown
// recipe"); that preference is now the SEAM's behaviour and every sibling client inherits it.

export interface Recipe {
  readonly slug: string
  readonly name: string
  readonly description?: string
  readonly prompt: string
  readonly assets: readonly string[]
  readonly builtin: boolean
  readonly updatedAt: number
}

export interface SaveRecipeInput {
  readonly slug?: string
  readonly name: string
  readonly description?: string
  readonly prompt: string
}

/** One `needs:` fact, probed against THIS machine. `unknown` is not `absent` — see `apps/recipes.ts`. */
export interface RecipeNeedCheck {
  readonly fact: string
  readonly status: "present" | "absent" | "unknown"
  readonly looked: readonly string[]
  readonly found?: string
}

/**
 * A recipe as its author wrote it (`GET /api/recipe/:slug/source`).
 *
 * ⚠️ `markdown` is the FILE'S OWN BYTES. The `Recipe` record above carries the prompt BODY only, so this
 * is the text-editing source rather than a two-field reconstruction. Folder export uses the ZIP endpoint
 * below so assets travel too.
 */
export interface RecipeSource {
  readonly slug: string
  readonly name: string
  readonly markdown: string
  readonly needs: readonly RecipeNeedCheck[]
  readonly produces: readonly string[]
  readonly collection: { readonly id: "examples" | "mine"; readonly title: string; readonly note: string }
}

/**
 * A PARTIAL edit. Omit a field to leave it exactly as the author wrote it; `description: null` removes
 * that line. Prefer this over `saveRecipe` whenever you are changing ONE thing: `save` takes a whole
 * recipe, so it makes a caller resend prose it did not author.
 */
export interface UpdateRecipeInput {
  readonly name?: string
  readonly description?: string | null
  readonly prompt?: string
  readonly needs?: readonly string[]
  readonly produces?: readonly string[]
}

export interface RunResult {
  readonly sessionID: string
  readonly directory: string
  readonly assets: readonly string[]
  /** What `verifyRecipe` will judge this cook on. Empty = the recipe declares no postcondition. */
  readonly produces: readonly string[]
  /**
   * The model this cook runs on, as `providerID/modelID` — the instance's own answer, so a caller that
   * named no model still learns which one it got. Pass it back to {@link verifyRecipe}: without it the
   * NOT AVAILABLE arm cannot fire from this app at all, and a tools-less model reads as a broken install.
   */
  readonly model?: string
}

/**
 * The deterministic verdict on a cook. A cook's outcome used to be prose, so nothing
 * could read it mechanically; this is the harness's own answer, read off the work directory.
 *
 * ⚠️ Four states, and collapsing any two of them is the bug this shape exists to prevent: `working` ·
 * `not-working` (the INSTANCE failed) · `not-available` (the MODEL could not — never show this as a fault
 * in the user's install) · `unknown` (we could not check — never show it as a success). `summary` is the
 * ready-made sentence; prefer it over composing one from `checks`, which is where the nuance gets lost.
 */
export interface VerifyCheck {
  readonly declared: string
  readonly outcome: "met" | "unmet" | "unknown"
  readonly reason?: "not-applicable" | "not-measured" | "measurement-failed" | "incomplete"
  readonly path?: string
  readonly checked: string
  readonly bytes?: number
}

export interface VerifyResult {
  readonly slug: string
  readonly name: string
  readonly directory: string
  readonly verdict: "working" | "not-working" | "not-available" | "unknown"
  readonly checks: readonly VerifyCheck[]
  readonly summary: string
  readonly at: number
  /**
   * What the COOK did, when a `sessionID` was supplied. `blocked` means it never reached the model, so
   * an empty folder is evidence about the endpoint and about nothing else — that is what stops a dead
   * model server rendering as *"Did not work · this NovaClaw"*. Absent ≠ `ran`.
   */
  readonly cookState?: "ran" | "blocked" | "stopped"
}

const call = <T>(server: ServerConnection.HttpBase, method: string, route: string, body?: unknown): Promise<T> =>
  instanceFetch<T>(server, { method, route, body })

/** Mirrors the engine's compressed ZIP budget so an oversized upload is refused before allocation. */
export const MAX_RECIPE_ARCHIVE_BYTES = 32 * 1024 * 1024
/** Archive transfers are bounded even if a remote instance accepts a connection and then stalls. */
export const RECIPE_ARCHIVE_TIMEOUT_MS = 60_000

export interface RecipeArchiveTransferOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

const readBoundedArchive = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RECIPE_ARCHIVE_BYTES) {
    await response.body?.cancel("recipe archive exceeded its byte budget")
    throw new Error(`That recipe ZIP is over ${MAX_RECIPE_ARCHIVE_BYTES / 1024 / 1024} MB`)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > MAX_RECIPE_ARCHIVE_BYTES) {
      await reader.cancel("recipe archive exceeded its byte budget")
      throw new Error(`That recipe ZIP is over ${MAX_RECIPE_ARCHIVE_BYTES / 1024 / 1024} MB`)
    }
    chunks.push(next.value)
  }
  const archive = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.byteLength
  }
  return archive
}

export const listRecipes = (server: ServerConnection.HttpBase) => call<Recipe[]>(server, "GET", "api/recipe")

export const saveRecipe = (server: ServerConnection.HttpBase, input: SaveRecipeInput) =>
  call<Recipe>(server, "POST", "api/recipe", input)

export const recipeSource = (server: ServerConnection.HttpBase, slug: string) =>
  call<RecipeSource>(server, "GET", `api/recipe/${encodeURIComponent(slug)}/source`)

export const updateRecipe = (server: ServerConnection.HttpBase, slug: string, patch: UpdateRecipeInput) =>
  call<Recipe>(server, "PATCH", `api/recipe/${encodeURIComponent(slug)}`, patch)

/** Store a `recipe.md` somebody else wrote, byte for byte, under a free slug. Never overwrites. */
export const importRecipe = (server: ServerConnection.HttpBase, input: { markdown: string; slug?: string }) =>
  call<Recipe>(server, "POST", "api/recipe/import", input)

/** Download the complete folder transport: recipe.md plus every nested binary/text asset. */
export const recipeArchive = async (
  server: ServerConnection.HttpBase,
  slug: string,
  options: RecipeArchiveTransferOptions = {},
): Promise<Uint8Array<ArrayBuffer>> => {
  return instanceFetchResponse(
    server,
    {
      method: "GET",
      route: `api/recipe/${encodeURIComponent(slug)}/archive`,
      headers: { accept: "application/zip" },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? RECIPE_ARCHIVE_TIMEOUT_MS,
    },
    readBoundedArchive,
  )
}

/** Import a complete recipe folder ZIP under a claimed free slug. Never overwrites. */
export const importRecipeArchive = (
  server: ServerConnection.HttpBase,
  archive: Uint8Array<ArrayBuffer>,
  options: RecipeArchiveTransferOptions & { readonly slug?: string } = {},
) => {
  if (archive.byteLength > MAX_RECIPE_ARCHIVE_BYTES)
    return Promise.reject(new Error(`That recipe ZIP is over ${MAX_RECIPE_ARCHIVE_BYTES / 1024 / 1024} MB`))
  return instanceFetch<Recipe>(server, {
    method: "POST",
    route: "api/recipe/archive",
    query: { slug: options.slug },
    headers: { "content-type": "application/zip", accept: "application/json" },
    rawBody: archive,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? RECIPE_ARCHIVE_TIMEOUT_MS,
  })
}

export const duplicateRecipe = (server: ServerConnection.HttpBase, slug: string) =>
  call<Recipe>(server, "POST", `api/recipe/${encodeURIComponent(slug)}/duplicate`, {})

export const removeRecipe = (server: ServerConnection.HttpBase, slug: string) =>
  call<void>(server, "DELETE", `api/recipe/${encodeURIComponent(slug)}`)

export const runRecipe = (
  server: ServerConnection.HttpBase,
  slug: string,
  input: { directory?: string; strict?: { enabled?: boolean; attempts?: number; wallMinutes?: number } } = {},
) => call<RunResult>(server, "POST", `api/recipe/${encodeURIComponent(slug)}/run`, input)

/**
 * Ask the instance what a cook actually produced. Read-only, runs nothing, and idempotent — safe to call
 * whenever the cook's session goes idle, and safe to call again on reopen instead of storing the answer.
 */
export const verifyRecipe = (
  server: ServerConnection.HttpBase,
  slug: string,
  input: { directory: string; model?: string; sessionID?: string },
) => call<VerifyResult>(server, "POST", `api/recipe/${encodeURIComponent(slug)}/verify`, input)
