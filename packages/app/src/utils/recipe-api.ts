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
