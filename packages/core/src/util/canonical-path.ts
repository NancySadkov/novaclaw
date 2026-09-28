import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export function windowsPath(value: string): string {
  if (process.platform !== "win32") return value
  return value
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
}

export function canonical(value: string): string {
  const absolute = resolve(windowsPath(value))
  let anchor = absolute
  const trailing: string[] = []
  for (;;) {
    try {
      const root = realpathSync.native(anchor)
      return trailing.length === 0 ? root : join(root, ...trailing.reverse())
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error
    }
    const parent = dirname(anchor)
    if (parent === anchor) return absolute
    trailing.push(basename(anchor))
    anchor = parent
  }
}

export function contains(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
}

export function containsCanonical(parent: string, child: string): boolean {
  return contains(canonical(parent), canonical(child))
}
