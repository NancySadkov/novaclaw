import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

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

export interface RunResult {
  readonly sessionID: string
  readonly directory: string
  readonly assets: readonly string[]
  /** What `verifyRecipe` will judge this cook on. Empty = the recipe declares no postcondition. */
  readonly produces: readonly string[]
}

/**
 * The deterministic verdict on a cook (`todo/recipes.md`). A cook's outcome used to be prose, so nothing
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
}

const call = <T>(server: ServerConnection.HttpBase, method: string, route: string, body?: unknown): Promise<T> =>
  instanceFetch<T>(server, { method, route, body })

export const listRecipes = (server: ServerConnection.HttpBase) => call<Recipe[]>(server, "GET", "api/recipe")

export const saveRecipe = (server: ServerConnection.HttpBase, input: SaveRecipeInput) =>
  call<Recipe>(server, "POST", "api/recipe", input)

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
  input: { directory: string; model?: string },
) => call<VerifyResult>(server, "POST", `api/recipe/${encodeURIComponent(slug)}/verify`, input)
