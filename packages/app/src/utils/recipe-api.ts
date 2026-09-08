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

/** Why a transfer that reached this client still carries no recipe. */
export type RecipeArchiveFault =
  /** Zero bytes arrived — an absent body, or one that read empty. */
  | "empty"
  /** Bytes arrived, but they are not a ZIP (a proxy's HTML notice, a JSON fault page). */
  | "not-a-zip"

/**
 * A download that SUCCEEDED at the HTTP level and carried no recipe.
 *
 * 🔴 **The failure this exists to stop is not an unreported one — it is a MATERIALISED one.** The
 * previous reader answered an absent body with `new Uint8Array()`, and zero bytes is a well-formed
 * empty archive as far as every downstream step is concerned: the export path blobbed it, named it
 * `<slug>.recipe.zip`, saved it and said *"Saved"*. The user learns their share is empty by opening
 * it later, on another machine, with nothing to compare it against — which is strictly worse than an
 * error, because a failure the product renders as a plausible artifact stops looking like a failure.
 * The whole point of the ZIP transport is that a share carries every byte; this was the one way it
 * could carry none and report success.
 *
 * So the invariant is at the READER, not the caller: **bytes that are not an archive never leave this
 * module**, and the only thing an export path can do with a failed transfer is name it.
 */
export class RecipeArchiveError extends Error {
  /** The recipe the transfer was for. Empty when an upload named no slug — the file is the subject. */
  readonly slug: string
  readonly fault: RecipeArchiveFault
  /** Which way the bytes were travelling, because the two failures are the user's and the instance's. */
  readonly direction: "download" | "upload"

  constructor(slug: string, fault: RecipeArchiveFault, direction: "download" | "upload" = "download") {
    const named = slug === "" ? "" : ` for “${slug}”`
    super(
      direction === "download"
        ? fault === "empty"
          ? `The instance sent no ZIP${named} — nothing was saved.`
          : `The instance sent something that is not a ZIP${named} — nothing was saved.`
        : fault === "empty"
          ? "That file is empty, so it carries no recipe."
          : "That file is not a ZIP, so it carries no recipe folder.",
    )
    this.name = "RecipeArchiveError"
    this.slug = slug
    this.fault = fault
    this.direction = direction
  }
}

/**
 * Every ZIP begins `PK`, whatever it holds — an empty archive is the 22-byte end-of-central-directory
 * record `PK\x05\x06…`, and a populated one opens with a local file header `PK\x03\x04`. Checking the
 * two letters and not the third byte is deliberate: it separates *an archive* from *an HTML login
 * page or a JSON fault a proxy answered 200 with*, which is the distinction that decides whether a
 * file lands on the user's disk, without this client claiming to know the ZIP variants a future
 * engine may write.
 */
const looksLikeZip = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b

const readBoundedArchive =
  (slug: string) =>
  async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_RECIPE_ARCHIVE_BYTES) {
      await response.body?.cancel("recipe archive exceeded its byte budget")
      throw new Error(`That recipe ZIP is over ${MAX_RECIPE_ARCHIVE_BYTES / 1024 / 1024} MB`)
    }
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    // ⚠️ An absent body is NOT a special case with its own early return — that is exactly how the
    // empty archive was born. It falls through to the same emptiness check every short read meets.
    while (reader) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_RECIPE_ARCHIVE_BYTES) {
        await reader.cancel("recipe archive exceeded its byte budget")
        throw new Error(`That recipe ZIP is over ${MAX_RECIPE_ARCHIVE_BYTES / 1024 / 1024} MB`)
      }
      chunks.push(next.value)
    }
    if (total === 0) throw new RecipeArchiveError(slug, "empty")
    const archive = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      archive.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (!looksLikeZip(archive)) throw new RecipeArchiveError(slug, "not-a-zip")
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

/**
 * Download the complete folder transport: recipe.md plus every nested binary/text asset.
 *
 * ⚠️ **Resolves with an archive or not at all.** A non-2xx is the seam's `InstanceFetchError`; a 2xx
 * that carried nothing usable is a {@link RecipeArchiveError}. Nothing here ever answers with bytes a
 * caller would have to inspect before deciding whether the download worked — see the class comment
 * for why that shape cost a user their share.
 */
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
    readBoundedArchive(slug),
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
  // The same refusal as the download, facing the other way: an empty or non-ZIP file is named here
  // rather than uploaded so the server can name it. One vocabulary for "that is not a recipe
  // archive", whichever direction the bytes were travelling.
  if (archive.byteLength === 0) return Promise.reject(new RecipeArchiveError(options.slug ?? "", "empty", "upload"))
  if (!looksLikeZip(archive)) return Promise.reject(new RecipeArchiveError(options.slug ?? "", "not-a-zip", "upload"))
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
