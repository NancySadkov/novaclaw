/**
 * The shared **default working directory** for folder-less agents — a "New Agent" started
 * without picking a project/folder still gets a real, safe, app-managed cwd here, so EVERY
 * agent always has a folder where it can do basic work (write & run a python script, jot a
 * file, etc.). Uniform handling: even a "basic chat" is an agent bound to a folder.
 *
 * It is a REAL host directory under `<data>/scratch` that the app fully controls — NOT the
 * user's home dir (safe by construction), and distinct from the FS-3 `vfs` (which is the
 * no-browsable-FS fallback). Env override exists for tests.
 */
export * as Scratch from "./scratch"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Global } from "./global"

/** The app-managed default scratch working directory. */
export function root(): string {
  return process.env.NOVACLAW_SCRATCH_ROOT ?? path.join(Global.Path.data, "scratch")
}

/**
 * Ensure the scratch dir exists with a short README explaining it. Idempotent; returns the
 * absolute path. Cheap to call on every `/path` request (like `VirtualFs.ensure`).
 */
export async function ensure(): Promise<string> {
  const base = root()
  await fsp.mkdir(base, { recursive: true })
  const readme = path.join(base, "README.md")
  if (!fs.existsSync(readme))
    await fsp.writeFile(
      readme,
      "# NovaClaw scratch workspace\n\nThis is the shared default working directory for agents " +
        "started without a project folder. Agents can freely create and run files here — it is a " +
        "safe, app-managed area (not your home directory). Pick a real project folder for an agent " +
        "when you want it to work on that project instead.\n",
    )
  return base
}

/** True when an absolute path is inside the scratch root (containment guard reuse). */
export function contains(target: string): boolean {
  const base = path.resolve(root())
  const resolved = path.resolve(target)
  return resolved === base || resolved.startsWith(base + path.sep)
}
