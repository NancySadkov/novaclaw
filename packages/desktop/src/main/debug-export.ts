import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export type DebugExportEntry = { name: string; path?: string; data?: Buffer }

/**
 * Files recent enough for a user-requested diagnostic export.
 *
 * There is deliberately no file-size filter. Every NovaClaw log producer is bounded at its source:
 * electron-log rotates at 5 MB, the network log at 20 MB, and the instance writer bounds even a
 * rotation-stuck active segment. Silently dropping the largest diagnostic was both redundant and the
 * worst possible failure mode — the file most likely to explain a flood disappeared from the export.
 */
export function collectRecentFiles(
  dir: string,
  prefix: string,
  windowMs: number,
  now = Date.now(),
): DebugExportEntry[] {
  if (!existsSync(dir)) return []
  const cutoff = now - windowMs
  const result: DebugExportEntry[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const file = join(current, entry)
      const info = statSync(file)
      if (info.isDirectory()) {
        walk(file)
        continue
      }
      if (info.mtimeMs < cutoff) continue
      if (file.endsWith(".heapsnapshot")) continue
      result.push({ name: join(prefix, file.slice(dir.length + 1)).replace(/\\/g, "/"), path: file })
    }
  }
  walk(dir)
  return result
}
