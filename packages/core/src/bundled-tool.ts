import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Where a tool NovaClaw ships with itself lives, when the launcher did not name one.
 *
 * The desktop sets `NOVACLAW_*_PATH` to its `resources/third-party/<tool>`. A standalone server has
 * no launcher to set them, so the same tree is resolved BESIDE the executable — a server distribution
 * keeps the binary and `third-party/` in one folder, and the `..` arm covers the desktop's
 * `resources/server/novaclaw.exe` layout where the tools sit one directory up.
 *
 * An explicit env value stays authoritative: a caller that names a path has already made the choice,
 * and silently preferring a copy beside the binary would make the two disagree quietly.
 */
export function bundledToolRoot(
  tool: string,
  fromEnv: string | undefined,
  execPath: string = process.execPath,
): string | undefined {
  if (fromEnv) return fromEnv
  const beside = dirname(execPath)
  for (const candidate of [join(beside, "third-party", tool), join(beside, "..", "third-party", tool)]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** A named file inside a bundled tool root — for tools the env names as a file (ripgrep's rg.exe). */
export function bundledToolFile(
  tool: string,
  file: string,
  fromEnv: string | undefined,
  execPath: string = process.execPath,
): string | undefined {
  if (fromEnv) return fromEnv
  const root = bundledToolRoot(tool, undefined, execPath)
  return root ? join(root, file) : undefined
}
