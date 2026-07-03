/**
 * FS-3 — the virtual / simulated filesystem fallback (the last slice of B9).
 *
 * Some hosts (phones, locked-down sandboxes) don't expose a browsable real filesystem, so
 * the picker + Files/Notes/projects must fall back to an app-private root NovaClaw manages.
 *
 * The elegant part: the virtual root is a REAL host directory under `<data>/vfs` that the
 * app fully controls — so EVERY shipped FS-1 endpoint (list/read/write/mkdir/trash) works
 * over it UNCHANGED. FS-3 is therefore just three things: (1) provision the root, (2)
 * advertise it (PathInfo.virtualRoot + a `virtual` flag), (3) the picker/Files default to
 * it when virtual mode is on. No per-op redirect plumbing.
 *
 * Virtual mode turns on when `NOVACLAW_VIRTUAL_FS` is set OR `virtualFs: true` in config OR
 * (future) a host probe reports no real FS. Default off — desktops browse the host FS.
 */
export * as VirtualFs from "./virtual-fs"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "./global"
import { Flag } from "./flag/flag"

const SUBDIRS = ["projects", "notes", "files"] as const

/** The app-private virtual FS root. Env override exists for tests. */
export function root(): string {
  return process.env.NOVACLAW_VIRTUAL_FS_ROOT ?? path.join(Global.Path.data, "vfs")
}

/**
 * Whether the virtual FS is the active file surface. `config` is the decoded global config
 * (or undefined) — a `virtualFs: true` there forces it, same as the env flag.
 */
export function enabled(config?: unknown): boolean {
  if (Flag.NOVACLAW_VIRTUAL_FS) return true
  return (config as { virtualFs?: unknown } | undefined)?.virtualFs === true
}

/**
 * Ensure the virtual root exists with its standard subdirs and a README that explains it.
 * Idempotent; returns the root. Cheap to call on every PathInfo request when virtual is on.
 */
export async function ensure(): Promise<string> {
  const base = root()
  await fsp.mkdir(base, { recursive: true })
  await Promise.all(SUBDIRS.map((sub) => fsp.mkdir(path.join(base, sub), { recursive: true })))
  const readme = path.join(base, "README.md")
  if (!fs.existsSync(readme))
    await fsp.writeFile(
      readme,
      "# NovaClaw workspace\n\nThis is NovaClaw's app-private workspace, used when the host does not " +
        "expose a browsable filesystem (phones, sandboxes). Your projects, notes, and files live here.\n",
    )
  return base
}

/** The default starting directory for the picker/Files under virtual mode (the projects subdir). */
export function defaultProjectDir(): string {
  return path.join(root(), "projects")
}

/** True when an absolute path is inside the virtual root (containment guard reuse). */
export function contains(target: string): boolean {
  const base = path.resolve(root())
  const resolved = path.resolve(target)
  return resolved === base || resolved.startsWith(base + path.sep)
}
