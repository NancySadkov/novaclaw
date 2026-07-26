import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Raw-fetch client for /api/recipe — NOT in the generated SDK (golden rule: never hand-edit
// packages/sdk/**/gen/**). Mirrors calendar-api.ts / messenger-api.ts. Recipes are instance-global, so the
// connection (base URL + creds) is the only routing needed.

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

async function call<T>(server: ServerConnection.HttpBase, method: string, route: string, body?: unknown): Promise<T> {
  const url = new URL(route, server.url.endsWith("/") ? server.url : `${server.url}/`)
  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(server.password
        ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    // The server sends a legible message for a bad name / unknown recipe — show THAT, not a bare status.
    const detail = await res
      .json()
      .then((data: unknown) => (data && typeof data === "object" && "message" in data ? String(data.message) : ""))
      .catch(() => "")
    throw new Error(detail || `${method} ${route} failed: ${res.status}`)
  }
  return (await res.json()) as T
}

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
