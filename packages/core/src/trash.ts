export * as Trash from "./trash"

import fs from "fs/promises"
import path from "path"
import { Global } from "./global"

// The safe-delete store (B8): agent/file deletions MOVE dated copies here instead of destroying
// them, so the user can restore to a specific date, an agent can self-restore a misfired rm, and
// entries expire on a TTL. Plain async functions over node:fs/promises (global.ts style) — no
// Effect service needed v1; the tool + HTTP handlers call these directly.
//
// Layout: <root>/<yyyy-mm-dd>/<epoch-ms>-<basename>/
//   payload      — the moved file OR directory, verbatim
//   entry.json   — { id, originalPath, trashedAt, type }
// id = "<yyyy-mm-dd>/<epoch-ms>-<basename>" (also the entry's relative dir under the root).

export const DEFAULT_TTL_MS = 2 * 24 * 3600 * 1000 // 2 days

export interface Entry {
  readonly id: string
  readonly originalPath: string
  readonly trashedAt: number
  readonly type: "file" | "directory"
}

/** Injectable seams for tests (temp root, fake clock, EXDEV simulation). */
export interface Options {
  readonly root?: string
  readonly now?: () => Date
  readonly renameFn?: (from: string, to: string) => Promise<void>
}

const trashRoot = (options?: Options) => options?.root ?? path.join(Global.Path.data, "trash")

// The id doubles as a path under the root, so it MUST stay traversal-proof: exactly one dated
// segment + one entry segment, no separators or dots-only names inside. Restore takes ids from
// HTTP clients — this gate is load-bearing.
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}\/\d+-[^/\\]+$/
export const isValidId = (id: string) => ID_PATTERN.test(id) && !id.includes("..")

const dateDir = (date: Date) => date.toISOString().slice(0, 10)

/** rename with a cross-device fallback: EXDEV (e.g. D:\ file → C:\ trash) → copy + delete. */
async function move(from: string, to: string, options?: Options) {
  const rename = options?.renameFn ?? fs.rename
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    await fs.cp(from, to, { recursive: true })
    await fs.rm(from, { recursive: true, force: true })
  }
}

/** Move a file or directory into the trash. Lazy-purges expired entries first. */
export async function trashPath(originalAbs: string, options?: Options): Promise<Entry> {
  await purgeExpired(DEFAULT_TTL_MS, options)
  const stat = await fs.stat(originalAbs)
  const now = (options?.now ?? (() => new Date()))()
  const root = trashRoot(options)
  const day = dateDir(now)
  const basename = path.basename(originalAbs)

  // Same-ms same-name collisions get a numeric suffix rather than clobbering.
  let entryName = `${now.getTime()}-${basename}`
  let dir = path.join(root, day, entryName)
  for (let attempt = 2; await exists(dir); attempt++) {
    entryName = `${now.getTime()}-${attempt}-${basename}`
    dir = path.join(root, day, entryName)
  }

  const entry: Entry = {
    id: `${day}/${entryName}`,
    originalPath: path.resolve(originalAbs),
    trashedAt: now.getTime(),
    type: stat.isDirectory() ? "directory" : "file",
  }

  await fs.mkdir(dir, { recursive: true })
  await move(originalAbs, path.join(dir, "payload"), options)
  await fs.writeFile(path.join(dir, "entry.json"), JSON.stringify(entry, null, 2), "utf8")
  return entry
}

/** All entries, newest first. Lazy-purges expired entries first. */
export async function listTrash(options?: Options): Promise<Entry[]> {
  await purgeExpired(DEFAULT_TTL_MS, options)
  const root = trashRoot(options)
  const entries: Entry[] = []
  for (const day of await readdirSafe(root)) {
    for (const name of await readdirSafe(path.join(root, day))) {
      const raw = await fs.readFile(path.join(root, day, name, "entry.json"), "utf8").catch(() => undefined)
      if (!raw) continue
      try {
        entries.push(JSON.parse(raw) as Entry)
      } catch {
        // A torn write mid-crash — skip rather than fail the whole listing.
      }
    }
  }
  return entries.sort((a, b) => b.trashedAt - a.trashedAt)
}

/** Restore an entry to its original path (collision → `<original>.restored-<epoch>`). */
export async function restore(
  id: string,
  input?: { overwrite?: boolean },
  options?: Options,
): Promise<string> {
  if (!isValidId(id)) throw new Error(`Invalid trash id: ${id}`)
  const dir = path.join(trashRoot(options), id)
  const raw = await fs.readFile(path.join(dir, "entry.json"), "utf8")
  const entry = JSON.parse(raw) as Entry

  let target = entry.originalPath
  if (!input?.overwrite && (await exists(target))) {
    const now = (options?.now ?? (() => new Date()))()
    target = `${entry.originalPath}.restored-${now.getTime()}`
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await move(path.join(dir, "payload"), target, options)
  await fs.rm(dir, { recursive: true, force: true })
  return target
}

/** Delete date-dirs strictly older than the TTL. Called lazily — no daemon. */
export async function purgeExpired(ttlMs: number = DEFAULT_TTL_MS, options?: Options): Promise<void> {
  const root = trashRoot(options)
  const now = (options?.now ?? (() => new Date()))()
  const cutoff = dateDir(new Date(now.getTime() - ttlMs))
  for (const day of await readdirSafe(root)) {
    // Date-dir names sort lexicographically = chronologically; strictly-older days only, so
    // nothing inside the TTL window is ever touched even across timezones.
    if (day < cutoff) await fs.rm(path.join(root, day), { recursive: true, force: true })
  }
}

async function exists(p: string) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false)
}

async function readdirSafe(p: string) {
  return fs.readdir(p).catch(() => [] as string[])
}
