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
import { randomUUID } from "node:crypto"
import path from "node:path"
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

/**
 * Where the session recipe files live under a resolved data directory — the ONE place that
 * layout is named. A caller that resolves the data root through `Global.Service` (rather than
 * the module-level `Global.Path`, so a test can point it at a temp dir) composes its `root`
 * with this instead of re-spelling the directory and silently reading an empty one if it moves.
 */
export const storeRootIn = (dataDirectory: string) => path.join(dataDirectory, "adhoc-tools")

const storeRoot = (options?: Options) => options?.root ?? storeRootIn(Global.Path.data)

// The tool name lists in the system prompt and keys lookups; the sessionID doubles as the
// store file name. Both MUST stay traversal-proof — models feed these values.
const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/
export const isValidName = (name: string) => NAME_PATTERN.test(name)
const SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,79}$/
const LOCK_WAIT_MS = 10
const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 60_000

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
    throw new Error(
      `Tool manual too long (${manual.length} > ${MAX_MANUAL_CHARS} chars) — keep it to the API shape and 1-2 examples`,
    )
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
  return [...byName.values()].filter((recipe) => recipe.enabled !== false).sort((a, b) => a.name.localeCompare(b.name))
}

const sessionFile = (sessionID: string, options?: Options) => {
  if (!SESSION_PATTERN.test(sessionID)) throw new Error(`Invalid session id: ${sessionID}`)
  return path.join(storeRoot(options), `${sessionID}.json`)
}

type Stored = { readonly recipes: Recipe[]; readonly corrupt: boolean }

const readStored = async (file: string): Promise<Stored> => {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!raw) return { recipes: [], corrupt: false }
  try {
    const parsed = JSON.parse(raw) as Recipe[]
    return { recipes: Array.isArray(parsed) ? parsed.filter((recipe) => recipe && isValidName(recipe.name)) : [], corrupt: false }
  } catch {
    // Keep mutation paths aware of the distinction. The read-only list API still degrades to [],
    // but a later write must not turn recoverable torn state into a healthy-looking partial file.
    return { recipes: [], corrupt: true }
  }
}

const lockFile = async (file: string): Promise<() => Promise<void>> => {
  const lock = `${file}.lock`
  const started = Date.now()
  await fs.mkdir(path.dirname(file), { recursive: true })
  while (true) {
    try {
      await fs.mkdir(lock)
      return async () => {
        await fs.rm(lock, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const stat = await fs.stat(lock).catch(() => undefined)
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        // The lock is scoped to the validated session file and only expires after a generous bound,
        // so a dead worker cannot strand every future mutation forever.
        await fs.rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS)
        throw new Error("Timed out waiting for the session tool catalogue lock.")
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_MS))
    }
  }
}

const withLocks = async <T>(files: readonly string[], action: () => Promise<T>): Promise<T> => {
  const releases: Array<() => Promise<void>> = []
  try {
    for (const file of [...new Set(files)].sort()) releases.push(await lockFile(file))
    return await action()
  } finally {
    for (const release of releases.reverse()) await release()
  }
}

const atomicWrite = async (file: string, value: string) => {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, "wx")
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

const unreadableCatalogue = (file: string) =>
  new Error(`Session tool catalogue is unreadable and was not overwritten: ${file}`)

/** Recipes the model defined in this session (empty on any read problem — never blocks). */
export async function listSessionRecipes(sessionID: string, options?: Options): Promise<Recipe[]> {
  return (await readStored(sessionFile(sessionID, options))).recipes
}

/** Upsert (by name) a session-scoped recipe. Returns the normalized recipe. */
export async function saveSessionRecipe(sessionID: string, input: Recipe, options?: Options): Promise<Recipe> {
  const recipe = normalizeRecipe(input)
  const file = sessionFile(sessionID, options)
  return withLocks([file], async () => {
    const stored = await readStored(file)
    if (stored.corrupt) throw unreadableCatalogue(file)
    const next = [...stored.recipes.filter((item) => item.name !== recipe.name), recipe]
    await atomicWrite(file, JSON.stringify(next, null, 2))
    return recipe
  })
}

/**
 * 4E: discard a session-defined recipe by name (the "throw this one away" half of the
 * review surface). Returns true when a recipe was removed. No-op / false when absent.
 */
export async function removeSessionRecipe(sessionID: string, name: string, options?: Options): Promise<boolean> {
  const file = sessionFile(sessionID, options)
  return withLocks([file], async () => {
    const stored = await readStored(file)
    if (stored.corrupt) throw unreadableCatalogue(file)
    const next = stored.recipes.filter((item) => item.name !== name)
    if (next.length === stored.recipes.length) return false
    if (next.length === 0) {
      await fs.rm(file, { force: true })
      return true
    }
    await atomicWrite(file, JSON.stringify(next, null, 2))
    return true
  })
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
  const source = sessionFile(fromSessionID, options)
  const target = sessionFile(toSessionID, options)
  return withLocks([source, target], async () => {
    const stored = await readStored(source)
    if (stored.corrupt) throw unreadableCatalogue(source)
    if (stored.recipes.length === 0) return 0
    await atomicWrite(target, JSON.stringify(stored.recipes, null, 2))
    return stored.recipes.length
  })
}
