import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { app } from "electron"
import { CHANNEL } from "./constants"

const APP_NAMES = { dev: "NovaClaw Dev", beta: "NovaClaw Beta", prod: "NovaClaw" }
const APP_IDS = { dev: "app.novaclaw.desktop.dev", beta: "app.novaclaw.desktop.beta", prod: "app.novaclaw.desktop" }

/** Must run before logging, runtime imports or the single-instance lock. The sidecar and Electron
 * share one resolved instance home, including Electron's lock and window-state files. */
export function prepareInstanceHome() {
  try {
    process.chdir(homedir())
  } catch {}
  process.env.NOVACLAW_DISABLE_EMBEDDED_WEB_UI = "true"
  const appId = app.isPackaged ? APP_IDS[CHANNEL] : APP_IDS.dev
  const testRoot =
    process.env.NOVACLAW_TEST_ONBOARDING === "1" ? join(tmpdir(), `novaclaw-onboarding-${randomUUID()}`) : undefined
  const home = resolveInstanceHome(process.argv, process.env.NOVACLAW_HOME)
  if (home) process.env.NOVACLAW_HOME = home
  if (testRoot) {
    for (const directory of ["data", "config", "cache", "state", "desktop", "session"])
      mkdirSync(join(testRoot, directory), { recursive: true })
    // This test selection wins over any inherited home, just as it wins for Electron userData.
    process.env.NOVACLAW_HOME = testRoot
    process.env.NOVACLAW_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(testRoot, "data")
    process.env.XDG_CONFIG_HOME = join(testRoot, "config")
    process.env.XDG_CACHE_HOME = join(testRoot, "cache")
    process.env.XDG_STATE_HOME = join(testRoot, "state")
    app.setPath("sessionData", join(testRoot, "session"))
  }
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : APP_NAMES.dev)
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    testRoot ? join(testRoot, "desktop") : home ? join(home, "desktop") : join(app.getPath("appData"), appId),
  )
  return { onboardingTest: testRoot !== undefined, userDataPath: app.getPath("userData") }
}

export function resolveInstanceHome(argv: readonly string[], environment?: string) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--home" || arg === "--home-dir") {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith("-") && next.trim() !== "") return resolve(next)
      continue
    }
    const assignment = /^--home(?:-dir)?=(.*)$/.exec(arg ?? "")
    if (assignment?.[1] !== undefined && assignment[1].trim() !== "") return resolve(assignment[1])
  }
  return environment?.trim() ? resolve(environment) : undefined
}
