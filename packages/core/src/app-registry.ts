export * as AppRegistry from "./app-registry"

import fs from "fs/promises"
import { randomUUID } from "node:crypto"
import path from "path"
import { isManifestRouteId, MANIFEST_ROUTE_IDS, type ManifestRouteId } from "./app-route"
import { Global } from "./global"
import { Slug } from "./util/slug"

// The persisted home-app registry (B14): the server-side half of the "make me an app" seam. An
// agent (or the user) registers a MANIFEST — a launcher, not code: open a closed built-in route id,
// a URL, or a chat draft pre-filled with a prompt. Manifests live one-per-file under
// Global.Path.data/apps/<id>.json;
// the client loads them on mount and merges them into registeredApps(). Plain async functions over
// node:fs/promises (trash.ts style) — the tool + HTTP handlers call these directly.

export type OpenType = "route" | "url" | "prompt"
export type Source = "agent" | "plugin"

export type ManifestOpen =
  | { readonly type: "route"; readonly value: ManifestRouteId }
  | { readonly type: "url"; readonly value: string }
  | { readonly type: "prompt"; readonly value: string }

export interface Manifest {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly accent?: string
  readonly subtitle?: string
  readonly open: ManifestOpen
  /** Who contributed the persistent launcher. Missing legacy values are treated as agent apps. */
  readonly source: Source
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SaveInput {
  readonly id?: string
  readonly title: string
  readonly icon?: string
  readonly accent?: string
  readonly subtitle?: string
  readonly open: { readonly type: OpenType; readonly value: string }
  readonly source?: Source
}

/** Injectable seams for tests (temp root, fake clock). */
export interface Options {
  readonly root?: string
  readonly now?: () => Date
}

const appsRoot = (options?: Options) => options?.root ?? path.join(Global.Path.data, "apps")

// The id doubles as the file name, so it MUST stay traversal-proof: lowercase slug only. The
// HTTP endpoint + tool both feed ids from clients/models — this gate is load-bearing.
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/
export const isValidId = (id: string) => ID_PATTERN.test(id)
const LOCK_WAIT_MS = 10
const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 60_000

// ⚠️ **A DECLARED MIRROR of `packages/app/src/apps/registry.tsx`.** The two lists must stay
// identical — this one guards the HTTP/tool path, that one guards the in-process `registerApp` a
// plugin reaches directly, and an id reserved on only one side is squattable through the other.
// `packages/core/test/app-reserved-ids.test.ts` reads BOTH files and fails on any divergence, and
// on any built-in tile that is not listed here.
//
// `debug` was missing from both halves until 2026-07-29 — the one tile whose whole job is to be
// reachable when the product is already broken (ruling 2 names Recovery-class surfaces
// explicitly), so a squatted `debug` takes away the screen a user needs precisely when nothing
// else works. `processes` is deliberately here without being a tile: it is a route.
const RESERVED_IDS = new Set([
  "tasks",
  // `chats` is the RETIRED id of the tile now called `tasks` (2026-08-13) and stays reserved for the
  // same reason `processes` and `search` do: a name a user's muscle memory still reaches for must
  // not become squattable the moment we stop shipping it.
  "chats",
  "notes",
  "files",
  "processes",
  "registry",
  "debug",
  // The roster (AGENTS.md — the structural metaphor). Reserved on both sides before it can be
  // squatted: an app that could impersonate the place a user goes to meet their colleagues is the
  // last id to leave open.
  "contacts",
  "memory-graph",
  "search",
  "terminal",
  "trash",
  "help",
  "social",
  "settings",
  "calendar",
  "recipes",
  "skills",
])

/** Derive a valid id from a title ("Stock Prices" -> "stock-prices"). */
export const slugify = Slug.from

const withFileLock = async <T>(file: string, action: () => Promise<T>): Promise<T> => {
  const lock = `${file}.lock`
  const started = Date.now()
  await fs.mkdir(path.dirname(file), { recursive: true })
  while (true) {
    try {
      await fs.mkdir(lock)
      try {
        return await action()
      } finally {
        await fs.rm(lock, { recursive: true, force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const stat = await fs.stat(lock).catch(() => undefined)
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS)
        throw new Error("Timed out waiting for the app manifest lock.")
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_WAIT_MS))
    }
  }
}

const atomicWrite = async (file: string, value: string): Promise<void> => {
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

const OPEN_TYPES: readonly OpenType[] = ["route", "url", "prompt"]

function normalizeOpen(open: SaveInput["open"]): Manifest["open"] {
  if (!OPEN_TYPES.includes(open.type)) throw new Error(`Invalid open.type "${open.type}": route | url | prompt`)
  const value = open.value.trim()
  if (!value) throw new Error("open.value must not be empty")
  if (open.type === "route") {
    if (!isManifestRouteId(value))
      throw new Error(`Unknown app route id "${value}". Choose one of: ${MANIFEST_ROUTE_IDS.join(", ")}`)
    return { type: "route", value }
  }
  if (open.type === "url") {
    if (!/^https?:\/\//.test(value)) throw new Error("open.value for a url app must start with http:// or https://")
    return { type: "url", value }
  }
  return { type: "prompt", value }
}

/** Validate + normalize a SaveInput; throws with a model/user-legible message. */
export function normalize(input: SaveInput, options?: Options): Manifest {
  const id = input.id?.trim() || slugify(input.title)
  if (!isValidId(id)) throw new Error(`Invalid app id "${id}": use a lowercase slug (a-z, 0-9, -, _)`)
  if (RESERVED_IDS.has(id)) throw new Error(`App id "${id}" is reserved by a built-in app`)
  if (!input.title.trim()) throw new Error("App title must not be empty")
  const open = normalizeOpen(input.open)
  const now = (options?.now ?? (() => new Date()))().getTime()
  return {
    id,
    title: input.title.trim(),
    ...(input.icon?.trim() ? { icon: input.icon.trim() } : {}),
    ...(input.accent?.trim() ? { accent: input.accent.trim() } : {}),
    ...(input.subtitle?.trim() ? { subtitle: input.subtitle.trim() } : {}),
    open,
    source: input.source ?? "agent",
    createdAt: now,
    updatedAt: now,
  }
}

/** Register (or update, by id) an app manifest. Returns the persisted manifest. */
export async function saveApp(input: SaveInput, options?: Options): Promise<Manifest> {
  const manifest = normalize(input, options)
  const root = appsRoot(options)
  const file = path.join(root, `${manifest.id}.json`)
  return withFileLock(file, async () => {
    const existing = await fs.readFile(file, "utf8").catch(() => undefined)
    let createdAt = manifest.createdAt
    if (existing) {
      try {
        createdAt = (JSON.parse(existing) as Manifest).createdAt ?? manifest.createdAt
      } catch {
        throw new Error(`Existing app manifest is unreadable and was not overwritten: ${file}`)
      }
    }
    const merged = { ...manifest, createdAt }
    await atomicWrite(file, JSON.stringify(merged, null, 2))
    return merged
  })
}

/** All persisted manifests, title-sorted. */
export async function listApps(options?: Options): Promise<Manifest[]> {
  const root = appsRoot(options)
  const names = await fs.readdir(root).catch(() => [] as string[])
  const manifests: Manifest[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const raw = await fs.readFile(path.join(root, name), "utf8").catch(() => undefined)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Manifest
      if (!isValidId(parsed.id) || !parsed.title || !parsed.open?.value) continue
      const open = normalizeOpen(parsed.open)
      if (parsed.source !== undefined && parsed.source !== "agent" && parsed.source !== "plugin") continue
      manifests.push({ ...parsed, source: parsed.source ?? "agent", open })
    } catch {
      // A torn write or a manifest from an older/free-form contract cannot cost the whole launcher.
    }
  }
  return manifests.sort((a, b) => a.title.localeCompare(b.title))
}

/** Remove a manifest by id. Returns whether it existed. */
export async function removeApp(id: string, options?: Options): Promise<boolean> {
  if (!isValidId(id)) throw new Error(`Invalid app id: ${id}`)
  const file = path.join(appsRoot(options), `${id}.json`)
  return withFileLock(file, () =>
    fs.rm(file).then(
      () => true,
      () => false,
    ),
  )
}
