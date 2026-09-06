import { Xdg } from "@novaclaw/core/util/xdg"
import { isAbsolute, join, relative, sep } from "node:path"

const APP = "novaclaw"

/**
 * The one root that owns both the instance runtime and the desktop shell.
 *
 * An explicit `--home` is already the root. Without one, core's data directory is the default
 * instance root (`~/.local/share/novaclaw`), not merely one component of it.
 */
export function resolveInstanceRoot(
  argv: readonly string[],
  environment: Xdg.Env,
  osHome: string | undefined,
  emergencyRoot: string,
) {
  const dirs = Xdg.baseDirs(argv, environment, osHome, APP)
  const root = dirs?.explicitHome ?? dirs?.data ?? emergencyRoot
  return !dirs?.explicitHome && environment.NOVACLAW_DEV_ISOLATED === "1" ? `${root}-dev` : root
}

export function desktopProfilePaths(instanceRoot: string) {
  const desktop = join(instanceRoot, "desktop")
  return {
    userData: desktop,
    sessionData: join(desktop, "session"),
  }
}

export function ensureDesktopProfile(
  instanceRoot: string,
  emergencyRoot: string,
  makeDirectory: (path: string) => void,
): { instanceRoot: string; profile: ReturnType<typeof desktopProfilePaths>; relocated: boolean } {
  const failures: string[] = []
  for (const root of [...new Set([instanceRoot, emergencyRoot])]) {
    const profile = desktopProfilePaths(root)
    try {
      makeDirectory(profile.userData)
      makeDirectory(profile.sessionData)
      return { instanceRoot: root, profile, relocated: root !== instanceRoot }
    } catch (error) {
      failures.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`NovaClaw could not create its desktop profile inside an instance home: ${failures.join("; ")}`)
}

export function isInsideInstanceRoot(instanceRoot: string, candidate: string) {
  const rel = relative(instanceRoot, candidate)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}
