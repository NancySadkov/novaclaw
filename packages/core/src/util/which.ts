import fs from "node:fs"
import path from "node:path"
import { Global } from "../global"

/**
 * Find a command on `PATH`, the way a shell would. Owned since 2026-09-03 (it was the `which`
 * package: one `which.sync` call behind fourteen lines, AGENTS.md principle 2).
 *
 * The rules, and where each is pinned (`test/util/which.test.ts`):
 * - `PATH` is split on `path.delimiter`; the first directory holding an executable wins.
 * - On win32 a bare name is tried with each `PATHEXT` extension in `PATHEXT`'s order, and a name
 *   that already ends in one of them is tried as given first. The match keeps `PATHEXT`'s spelling
 *   of the extension (`pathext` under `PATHEXT=.CMD` answers `…\pathext.CMD`), and the filesystem
 *   is case-insensitive, so that is also how the file is found.
 * - Elsewhere a candidate must be a regular file this process may execute (`X_OK`), so a file of
 *   the right name without the bit answers `null`.
 * - `Global.Path.bin` is always searched last, so the tools NovaClaw installs for itself are found
 *   even when the caller's `PATH` is a stranger's.
 * - `env.Path` / `env.PathExt` are the Windows spellings and answer the same as the upper-case ones.
 */
export function which(cmd: string, env?: NodeJS.ProcessEnv): string | null {
  if (!cmd) return null
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  const dirs = base.split(path.delimiter).filter((dir) => dir.length > 0)
  dirs.push(Global.Path.bin)
  const win32 = process.platform === "win32"
  const pathExt = env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt
  const extensions = win32 ? (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0) : []
  const lower = cmd.toLowerCase()
  const complete = win32 && extensions.some((ext) => lower.endsWith(ext.toLowerCase()))
  const names = win32 ? (complete ? [cmd] : []).concat(extensions.map((ext) => cmd + ext)) : [cmd]
  // A command given with a directory is resolved against that directory only, as a shell does.
  const roots = cmd.includes("/") || (win32 && cmd.includes("\\")) ? [""] : dirs
  for (const dir of roots) {
    for (const name of names) {
      const candidate = dir ? path.join(dir, name) : path.resolve(name)
      if (executable(candidate, win32)) return candidate
    }
  }
  return null
}

function executable(file: string, win32: boolean): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (!win32) fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
