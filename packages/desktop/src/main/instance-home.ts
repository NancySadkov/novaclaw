import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { app } from "electron"
import { Xdg } from "@novaclaw/core/util/xdg"
import { CHANNEL } from "./constants"
import { ensureDesktopProfile, resolveInstanceRoot } from "./instance-home-path"

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
  const selectedHome = Xdg.homeOverride(process.argv, process.env)
  const home = selectedHome ? resolve(selectedHome) : undefined
  if (home) process.env.NOVACLAW_HOME = home
  if (testRoot) {
    for (const directory of ["data", "config", "cache", "state", "desktop"])
      mkdirSync(join(testRoot, directory), { recursive: true })
    // This test selection wins over any inherited home, just as it wins for Electron userData.
    process.env.NOVACLAW_HOME = testRoot
    process.env.NOVACLAW_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(testRoot, "data")
    process.env.XDG_CONFIG_HOME = join(testRoot, "config")
    process.env.XDG_CACHE_HOME = join(testRoot, "cache")
    process.env.XDG_STATE_HOME = join(testRoot, "state")
  }
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : APP_NAMES.dev)
  app.setAppUserModelId(appId)
  const emergencyRoot = join(app.getPath("temp"), "novaclaw-home")
  const selectedRoot =
    testRoot ?? resolveInstanceRoot(process.argv, process.env, homedir() || app.getPath("home"), emergencyRoot)
  const prepared = ensureDesktopProfile(selectedRoot, emergencyRoot, (directory) =>
    mkdirSync(directory, { recursive: true }),
  )
  const { instanceRoot, profile } = prepared
  // A dev build is a separate instance, not a production instance with only its renderer moved.
  // A failed selected home relocates both halves too; never let Electron and the sidecar disagree.
  if ((!home && process.env.NOVACLAW_DEV_ISOLATED === "1") || prepared.relocated)
    process.env.NOVACLAW_HOME = instanceRoot
  if (prepared.relocated)
    console.error(
      `[novaclaw] WARNING: the selected instance home could not hold the desktop profile; ` +
        `the complete instance is using ${instanceRoot} for this run.`,
    )
  // Chromium preferences, renderer stores, window state, cookies and caches are instance state too.
  // Set both roots explicitly: relying on Electron's platform default created a second remembered
  // instance in %APPDATA%, outside the home selected by NovaClaw.
  app.setPath("userData", profile.userData)
  app.setPath("sessionData", profile.sessionData)
  return { onboardingTest: testRoot !== undefined, instanceRoot, userDataPath: app.getPath("userData") }
}
