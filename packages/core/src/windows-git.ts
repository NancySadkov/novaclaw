export * as WindowsGit from "./windows-git"

import { statSync } from "node:fs"
import path from "node:path"
import { Flag } from "./flag/flag"
import { bundledToolRoot } from "./bundled-tool"

const portableGitRoot = () => {
  const root = bundledToolRoot("portable-git", Flag.NOVACLAW_PORTABLE_GIT_PATH)
  if (!root)
    throw new Error(
      "NovaClaw's bundled Git and Bash are missing. Restore the third-party/portable-git folder from the NovaClaw distribution.",
    )
  return root
}

export function binary(): string | undefined {
  if (process.platform !== "win32") return
  const root = portableGitRoot()
  const executable = path.join(root, "cmd", "git.exe")
  if (!statSync(executable, { throwIfNoEntry: false })?.isFile())
    throw new Error(`The embedded Git installation is incomplete: ${executable}`)
  return executable
}

export function commandDirectory(): string | undefined {
  const executable = binary()
  return executable ? path.dirname(executable) : undefined
}

export function pathPrepend(): string[] {
  if (process.platform !== "win32") return []
  const root = portableGitRoot()
  binary()
  bash()
  return ["mingw64/bin", "usr/bin", "cmd"].map((relative) => path.join(root, relative))
}

export function bash(): string | undefined {
  if (process.platform !== "win32") return
  const root = portableGitRoot()
  const executable = path.join(root, "usr", "bin", "bash.exe")
  if (!statSync(executable, { throwIfNoEntry: false })?.isFile())
    throw new Error(`The embedded Bash installation is incomplete: ${executable}`)
  return executable
}
