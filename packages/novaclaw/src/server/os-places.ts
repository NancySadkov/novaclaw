import fs from "fs/promises"
import path from "path"

// Well-known user folders on the INSTANCE host — the picker's "Places" rail. Server-side by
// design: the picker browses the filesystem where the server RUNS (a headless Spark has no
// Desktop; a remote client's own OS folders would be wrong paths). Windows/macOS ship fixed
// conventional names under home; Linux honors the XDG user-dirs config where present and GTK
// bookmarks add the user's own curated entries. Everything is existence-checked — a place that
// doesn't exist is not offered.

export type Place = { name: string; path: string }

const CONVENTIONAL = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"] as const

/** Parse ~/.config/user-dirs.dirs (`XDG_DOWNLOAD_DIR="$HOME/Downloads"`). Pure. */
export function parseXdgUserDirs(text: string, home: string): Place[] {
  const places: Place[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"([^"]+)"\s*$/.exec(line)
    if (!match) continue
    const resolved = match[2]!.replace(/^\$HOME/, home)
    // `$HOME` alone is the XDG "disabled" convention — not a place.
    if (resolved === home || !resolved) continue
    const name = match[1]!
    places.push({ name: name.charAt(0) + name.slice(1).toLowerCase(), path: resolved })
  }
  return places
}

/** Parse ~/.config/gtk-3.0/bookmarks (`file:///path Optional Label` per line). Pure. */
export function parseGtkBookmarks(text: string): Place[] {
  const places: Place[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("file://")) continue
    const space = trimmed.indexOf(" ")
    const uri = space === -1 ? trimmed : trimmed.slice(0, space)
    const label = space === -1 ? "" : trimmed.slice(space + 1).trim()
    let decoded: string
    try {
      decoded = decodeURIComponent(uri.slice("file://".length))
    } catch {
      continue
    }
    if (!decoded) continue
    places.push({ name: label || path.basename(decoded) || decoded, path: decoded })
  }
  return places
}

const exists = (target: string) =>
  fs.stat(target).then(
    (stat) => stat.isDirectory(),
    () => false,
  )

const readSafe = (target: string) => fs.readFile(target, "utf8").catch(() => undefined)

/** Dedupe by path (case-insensitive on Windows), preserving first occurrence. */
export function dedupePlaces(places: Place[], platform: string = process.platform): Place[] {
  const seen = new Set<string>()
  const result: Place[] = []
  for (const place of places) {
    const key = platform === "win32" ? place.path.toLowerCase() : place.path
    if (seen.has(key)) continue
    seen.add(key)
    result.push(place)
  }
  return result
}

/** The instance host's existing well-known folders + user file-manager bookmarks (Linux). */
export async function probePlaces(home: string): Promise<Place[]> {
  if (!home) return []
  const candidates: Place[] = []
  if (process.platform === "linux") {
    const xdg = await readSafe(path.join(home, ".config", "user-dirs.dirs"))
    if (xdg) candidates.push(...parseXdgUserDirs(xdg, home))
  }
  for (const name of CONVENTIONAL) candidates.push({ name, path: path.join(home, name) })
  if (process.platform === "linux") {
    const gtk = await readSafe(path.join(home, ".config", "gtk-3.0", "bookmarks"))
    if (gtk) candidates.push(...parseGtkBookmarks(gtk))
  }
  const deduped = dedupePlaces(candidates)
  const checks = await Promise.all(deduped.map((place) => exists(place.path)))
  return deduped.filter((_, index) => checks[index]).slice(0, 16)
}

export * as OsPlaces from "./os-places"
