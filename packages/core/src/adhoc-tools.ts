/**
 * P4 (4A) — the ad-hoc tool registry. An ad-hoc tool is just a named RECIPE
 * `{ name, description, manual }`: the system prompt lists only name + description
 * (progressive disclosure — 20 tools cost ~20 lines), the model pulls the `manual`
 * on demand via `tool_manual`, then runs it through bash/curl/python — so recipes
 * inherit the 1I–1K permission gating at execution and are never a bypass.
 *
 * Scopes resolve session ▷ project ▷ global: config carries global/project recipes
 * (the config layering already orders global before project), and `define_tool`
 * persists model-written recipes at SESSION scope only — never silently global —
 * as JSON files under Global.Path.data/adhoc-tools/<sessionID>.json (the B14
 * app-registry pattern: traversal-proof file names, torn reads skipped).
 */
export * as AdhocTools from "./adhoc-tools"

import fs from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Global } from "./global"

export interface Recipe {
  readonly name: string
  readonly description: string
  readonly manual: string
  readonly enabled?: boolean
}

/** Injectable seams for tests (temp root). */
export interface Options {
  readonly root?: string
}

const storeRoot = (options?: Options) => options?.root ?? path.join(Global.Path.data, "adhoc-tools")

// The tool name lists in the system prompt and keys lookups; the sessionID doubles as the
// store file name. Both MUST stay traversal-proof — models feed these values.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/
export const isValidName = (name: string) => NAME_PATTERN.test(name)
const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,79}$/

export const MAX_DESCRIPTION_CHARS = 300
export const MAX_MANUAL_CHARS = 8_192

/** Validate + normalize a recipe; throws with a model-legible message. */
export function normalizeRecipe(input: Recipe): Recipe {
  const name = input.name?.trim()
  if (!name || !isValidName(name))
    throw new Error(`Invalid tool name "${input.name}": use a lowercase slug (a-z, 0-9, -, _), max 64 chars`)
  const description = input.description?.trim()
  if (!description) throw new Error("Tool description must not be empty")
  if (description.length > MAX_DESCRIPTION_CHARS)
    throw new Error(`Tool description too long (${description.length} > ${MAX_DESCRIPTION_CHARS} chars)`)
  const manual = input.manual?.trim()
  if (!manual) throw new Error("Tool manual must not be empty")
  if (manual.length > MAX_MANUAL_CHARS)
    throw new Error(`Tool manual too long (${manual.length} > ${MAX_MANUAL_CHARS} chars) — keep it to the API shape and 1-2 examples`)
  return { name, description, manual, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) }
}

/**
 * Merge recipe layers, LATER layers overriding earlier by name (pass
 * [globalConfig, projectConfig, session] — session wins). Recipes with
 * `enabled: false` are dropped AFTER the merge, so a later scope can disable
 * an earlier one by name. Result is name-sorted for a stable prompt listing.
 */
export function mergeRecipes(...layers: ReadonlyArray<ReadonlyArray<Recipe> | undefined>): Recipe[] {
  const byName = new Map<string, Recipe>()
  for (const layer of layers) for (const recipe of layer ?? []) byName.set(recipe.name, recipe)
  return [...byName.values()]
    .filter((recipe) => recipe.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
}

const sessionFile = (sessionID: string, options?: Options) => {
  if (!SESSION_PATTERN.test(sessionID)) throw new Error(`Invalid session id: ${sessionID}`)
  return path.join(storeRoot(options), `${sessionID}.json`)
}

/** Recipes the model defined in this session (empty on any read problem — never blocks). */
export async function listSessionRecipes(sessionID: string, options?: Options): Promise<Recipe[]> {
  const raw = await fs.readFile(sessionFile(sessionID, options), "utf8").catch(() => undefined)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Recipe[]
    return Array.isArray(parsed) ? parsed.filter((recipe) => recipe && isValidName(recipe.name)) : []
  } catch {
    return [] // torn write mid-crash — skip rather than fail the session
  }
}

/** Upsert (by name) a session-scoped recipe. Returns the normalized recipe. */
export async function saveSessionRecipe(sessionID: string, input: Recipe, options?: Options): Promise<Recipe> {
  const recipe = normalizeRecipe(input)
  const file = sessionFile(sessionID, options)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const existing = await listSessionRecipes(sessionID, options)
  const next = [...existing.filter((item) => item.name !== recipe.name), recipe]
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8")
  return recipe
}

/**
 * 4E: promote a session recipe into a config file's `adhoc_tools` array (comment-preserving
 * jsonc patch), so a useful model-defined recipe becomes permanent at project/global scope.
 * Upsert by name: an existing entry with the same name is replaced in place; else appended.
 */
export function promoteRecipeToConfig(configText: string, recipe: Recipe): string {
  const normalized = normalizeRecipe(recipe)
  const entry = {
    name: normalized.name,
    description: normalized.description,
    manual: normalized.manual,
    ...(normalized.enabled === undefined ? {} : { enabled: normalized.enabled }),
  }
  const text = configText.trim() ? configText : "{}\n"
  const current = parse(text) as { adhoc_tools?: Array<{ name?: string }> } | undefined
  const list = Array.isArray(current?.adhoc_tools) ? current!.adhoc_tools! : []
  const index = list.findIndex((item) => item?.name === normalized.name)
  const at = index >= 0 ? index : list.length
  const edits = modify(text, ["adhoc_tools", at], entry, {
    isArrayInsertion: index < 0,
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  return applyEdits(text, edits)
}

/**
 * 4E: discard a session-defined recipe by name (the "throw this one away" half of the
 * review surface). Returns true when a recipe was removed. No-op / false when absent.
 */
export async function removeSessionRecipe(sessionID: string, name: string, options?: Options): Promise<boolean> {
  const existing = await listSessionRecipes(sessionID, options)
  const next = existing.filter((item) => item.name !== name)
  if (next.length === existing.length) return false
  const file = sessionFile(sessionID, options)
  if (next.length === 0) {
    await fs.rm(file, { force: true })
    return true
  }
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8")
  return true
}

/**
 * 4D: a spawned child inherits its parent's session-defined recipes — the session scope IS
 * the "parent hands its sub-agents a tool set" channel. Copy-on-spawn (not shared): the child
 * may define/override recipes without touching the parent's. No-op when the parent has none.
 */
export async function copySessionRecipes(
  fromSessionID: string,
  toSessionID: string,
  options?: Options,
): Promise<number> {
  const recipes = await listSessionRecipes(fromSessionID, options)
  if (recipes.length === 0) return 0
  const file = sessionFile(toSessionID, options)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(recipes, null, 2), "utf8")
  return recipes.length
}
