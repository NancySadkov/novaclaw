export * as AppRegistry from "./app-registry"

import fs from "fs/promises"
import path from "path"
import { Global } from "./global"

// The persisted home-app registry (B14): the server-side half of the "make me an app" seam. An
// agent (or the user) registers a MANIFEST — a launcher, not code: open a route, a URL, or a chat
// draft pre-filled with a prompt. Manifests live one-per-file under Global.Path.data/apps/<id>.json;
// the client loads them on mount and merges them into registeredApps(). Plain async functions over
// node:fs/promises (trash.ts style) — the tool + HTTP handlers call these directly.

export type OpenType = "route" | "url" | "prompt"

export interface Manifest {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly accent?: string
  readonly subtitle?: string
  readonly open: { readonly type: OpenType; readonly value: string }
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

const RESERVED_IDS = new Set([
  "chats",
  "notes",
  "files",
  "processes",
  "registry",
  "memory-graph",
  "search",
  "terminal",
  "trash",
  "help",
  "social",
  "settings",
  "calendar",
  "recipes",
])

/** Derive a valid id from a title ("Stock Prices" -> "stock-prices"). */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

const OPEN_TYPES: readonly OpenType[] = ["route", "url", "prompt"]

/** Validate + normalize a SaveInput; throws with a model/user-legible message. */
export function normalize(input: SaveInput, options?: Options): Manifest {
  const id = input.id?.trim() || slugify(input.title)
  if (!isValidId(id)) throw new Error(`Invalid app id "${id}": use a lowercase slug (a-z, 0-9, -, _)`)
  if (RESERVED_IDS.has(id)) throw new Error(`App id "${id}" is reserved by a built-in app`)
  if (!input.title.trim()) throw new Error("App title must not be empty")
  if (!OPEN_TYPES.includes(input.open.type)) throw new Error(`Invalid open.type "${input.open.type}": route | url | prompt`)
  const value = input.open.value.trim()
  if (!value) throw new Error("open.value must not be empty")
  if (input.open.type === "url" && !/^https?:\/\//.test(value))
    throw new Error("open.value for a url app must start with http:// or https://")
  if (input.open.type === "route" && !value.startsWith("/"))
    throw new Error("open.value for a route app must start with /")
  const now = (options?.now ?? (() => new Date()))().getTime()
  return {
    id,
    title: input.title.trim(),
    ...(input.icon?.trim() ? { icon: input.icon.trim() } : {}),
    ...(input.accent?.trim() ? { accent: input.accent.trim() } : {}),
    ...(input.subtitle?.trim() ? { subtitle: input.subtitle.trim() } : {}),
    open: { type: input.open.type, value },
    createdAt: now,
    updatedAt: now,
  }
}

/** Register (or update, by id) an app manifest. Returns the persisted manifest. */
export async function saveApp(input: SaveInput, options?: Options): Promise<Manifest> {
  const manifest = normalize(input, options)
  const root = appsRoot(options)
  await fs.mkdir(root, { recursive: true })
  const file = path.join(root, `${manifest.id}.json`)
  const existing = await fs.readFile(file, "utf8").catch(() => undefined)
  const merged = existing
    ? { ...manifest, createdAt: (JSON.parse(existing) as Manifest).createdAt ?? manifest.createdAt }
    : manifest
  await fs.writeFile(file, JSON.stringify(merged, null, 2), "utf8")
  return merged
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
      if (isValidId(parsed.id) && parsed.title && parsed.open?.value) manifests.push(parsed)
    } catch {
      // A torn write mid-crash — skip rather than fail the whole listing.
    }
  }
  return manifests.sort((a, b) => a.title.localeCompare(b.title))
}

/** Remove a manifest by id. Returns whether it existed. */
export async function removeApp(id: string, options?: Options): Promise<boolean> {
  if (!isValidId(id)) throw new Error(`Invalid app id: ${id}`)
  const file = path.join(appsRoot(options), `${id}.json`)
  return fs.rm(file).then(
    () => true,
    () => false,
  )
}
