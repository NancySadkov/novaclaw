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
//
// RETENTION LIVES ON THE WRITE PATHS ONLY (todo.md ruling 2 — *a read never destroys*).
// `listTrash` used to open with a `purgeExpired`, so merely LISTING the trash — `GET /file/trash`,
// i.e. opening the Trash app — destroyed the user's expired entries. That is the lazy-purge-on-read
// the ruling names, on the one store whose entire job is to not lose things. It is gone.
//
// The sweep now rides the two calls that MUTATE the store, which is enough on its own: `trashPath`
// is the only thing that ever GROWS the trash and every trash passes through it, so one sweep per
// write bounds the store by the TTL instead of by install age — no daemon, and no purge hidden
// inside a read. (Same argument, same shape as the Strict-drain purge in `jh/store.ts`.) `restore`
// sweeps too, AFTER its own entry is safely out, so an active user reclaims disk without ever
// having the sweep eat the entry they asked for.
//
// The honest consequence, stated rather than hidden: the TTL is a retention FLOOR, not a deadline.
// An instance that stops trashing stops sweeping, so an expired entry can outlive the TTL until the
// next write. It is bounded (nothing new arrives either) and it errs toward keeping the user's
// data, which is the direction this store exists to err in. Callers that want expiry at a specific
// moment call `purgeExpired` directly — it is exported for exactly that, and must never be called
// from a read.

export const DEFAULT_TTL_MS = 2 * 24 * 3600 * 1000 // 2 days

export interface Entry {
  readonly id: string
  readonly originalPath: string
  readonly trashedAt: number
  readonly type: "file" | "directory"
}

/** Injectable seams for tests (temp root, fake clock, EXDEV simulation, a failing sweep). */
export interface Options {
  readonly root?: string
  readonly now?: () => Date
  readonly renameFn?: (from: string, to: string) => Promise<void>
  /** Only the retention sweep's date-dir removal. Lets a test prove the sweep is best-effort on
   *  the write paths without depending on an un-removable directory, which no OS gives portably. */
  readonly purgeRmFn?: (target: string) => Promise<void>
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

/**
 * The retention sweep as it rides a mutation: best-effort, never throws.
 *
 * Housekeeping must not be able to fail the user's actual operation — an EPERM on some unrelated
 * expired directory is not a reason to refuse to trash the file they just asked to delete, nor to
 * report a restore that already succeeded as failed. Same stance, and same reason, as
 * `sweepStaleForks` in the Strict runner. `purgeExpired` itself stays strict for callers that ask
 * for expiry on purpose and want to know whether it worked.
 */
async function sweepRetention(options?: Options): Promise<void> {
  await purgeExpired(DEFAULT_TTL_MS, options).catch(() => {})
}

/** Move a file or directory into the trash. Sweeps expired entries first (this is a WRITE). */
export async function trashPath(originalAbs: string, options?: Options): Promise<Entry> {
  await sweepRetention(options)
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

/**
 * All entries, newest first. **Pure read — destroys nothing** (todo.md ruling 2).
 *
 * Do not reintroduce a sweep here. Expired-but-not-yet-swept entries are listed as what they are:
 * still on disk, still restorable. Filtering them out would be the same lie in the other direction
 * — hiding data the user could still get back.
 */
export async function listTrash(options?: Options): Promise<Entry[]> {
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

/**
 * Restore an entry to its original path (collision → `<original>.restored-<epoch>`).
 *
 * Sweeps expired entries too — this is a WRITE — but strictly AFTER the payload is out and the
 * entry dir removed. Ordering is load-bearing: an entry may itself be past the TTL and still be
 * sitting there, and a sweep that ran first would delete the very thing the user asked to restore.
 */
export async function restore(id: string, input?: { overwrite?: boolean }, options?: Options): Promise<string> {
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
  await sweepRetention(options)
  return target
}

/**
 * Delete date-dirs strictly older than the TTL. Called lazily from the WRITE paths — no daemon.
 *
 * Also the explicit maintenance entry point: it is exported so a caller can run expiry at a moment
 * of its choosing and observe whether it worked (unlike the best-effort `sweepRetention` that rides
 * mutations, this one throws). **Never call it from a read path** — that is the exact defect this
 * module was fixed for.
 */
export async function purgeExpired(ttlMs: number = DEFAULT_TTL_MS, options?: Options): Promise<void> {
  const root = trashRoot(options)
  const now = (options?.now ?? (() => new Date()))()
  const cutoff = dateDir(new Date(now.getTime() - ttlMs))
  const rm = options?.purgeRmFn ?? ((target: string) => fs.rm(target, { recursive: true, force: true }))
  for (const day of await readdirSafe(root)) {
    // Date-dir names sort lexicographically = chronologically; strictly-older days only, so
    // nothing inside the TTL window is ever touched even across timezones.
    if (day < cutoff) await rm(path.join(root, day))
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
