import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, dialog } from "electron"

import { Cause, Deferred, Effect, Exit, Schedule } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { bootWindowFirst, describeSidecarFailure } from "./boot"
import { createBootTimeline, formatMark, formatSummary, type BootPhase, type ProcessMemory } from "./boot-timeline"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { logDirectoryNotice } from "./log-directory"
import {
  exportDebugLogs,
  getLogDirectory,
  initCrashReporter,
  initLogging,
  startNetLog,
  write as writeLog,
} from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  checkOfflineEnabled,
  superviseLocalServer,
  type SidecarListener,
} from "./server"
import type { SuperviseStatus } from "@novaclaw/script/supervise"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"

const APP_NAMES: Record<string, string> = {
  dev: "NovaClaw Dev",
  beta: "NovaClaw Beta",
  prod: "NovaClaw",
}
const APP_IDS: Record<string, string> = {
  dev: "app.novaclaw.desktop.dev",
  beta: "app.novaclaw.desktop.beta",
  prod: "app.novaclaw.desktop",
}
const TEST_ONBOARDING = process.env.NOVACLAW_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>

/**
 * The boot timeline (`todo/startup.md`). Module scope because the marks are taken from four
 * different places — this fiber, the window-first callback, and two IPC handlers the renderer calls.
 *
 * ⚠️ `getCreationTime()` is the anchor, NOT `performance.timeOrigin`. In a packaged build the main
 * script runs long after the process exists, and anchoring at module load would exclude Electron's
 * own startup — the largest slice of a cold boot. It can return `null` on platforms that cannot
 * answer, and the fallback is stated rather than silent, because a timeline that quietly re-anchors
 * itself reports a fast startup that never happened.
 */
const processStartedAt = process.getCreationTime?.() ?? null
const bootTimeline = createBootTimeline({
  now: () => Date.now(),
  processStartedAt: processStartedAt ?? Date.now(),
  memory: () => readProcessMemory(),
})

/**
 * Per-process memory for the whole Electron app.
 *
 * ⚠️ Working set, which UNDERSTATES — `getAppMetrics` exposes no commit figure. Read it as a floor.
 * Never throws: an instrument that can fail the thing it measures is worse than no instrument.
 */
function readProcessMemory(): readonly ProcessMemory[] {
  try {
    return app.getAppMetrics().map((entry) => ({
      // ⚠️ The NAME when there is one, not just the type. A packaged run reports two processes both
      // typed `Utility` — the network service and our own sidecar — and the sidecar is the one whose
      // memory anyone reading this actually wants. Two identically-labelled rows are not a
      // measurement of either.
      kind: entry.name ? `${entry.type}:${entry.name}` : entry.type,
      pid: entry.pid,
      workingSetBytes: (entry.memory?.workingSetSize ?? 0) * 1024,
    }))
  } catch {
    return []
  }
}

/** Take a boot mark and log it. A repeat is dropped by the timeline and logs nothing. */
function markBoot(phase: BootPhase) {
  const mark = bootTimeline.mark(phase)
  if (!mark) return
  logger?.log(formatMark(mark))
  // The last phase there is, so the timeline is complete and worth stating as a whole. An
  // incomplete boot gets the same line at quit — see below — because the runs worth reading are
  // exactly the ones that never got here.
  if (phase === "first-chat-token") logger?.log(formatSummary(bootTimeline.summary()))
}

/**
 * ⚠️ A boot that never reaches its last phase is the one worth measuring, and it would otherwise
 * leave no summary at all. Emitting it at quit means every run produces exactly one, with the
 * unreached phases named.
 */
app.on("will-quit", () => {
  const summary = bootTimeline.summary()
  if (summary.missing.length > 0) logger?.log(formatSummary(summary))
})

let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null

/**
 * The sidecar supervisor's phase, held HERE because the renderer cannot ask the instance about it.
 *
 * The whole point of the terminal `gave-up` phase is that the server is gone and is not coming back
 * on its own — so the only process that can still answer is this one. Starts as `running` because
 * every reader of it is created after the first sidecar has passed its health gate; a boot that
 * never gets there fails through `forwardInitializationFailure` instead.
 */
let supervisorState: SuperviseStatus = { phase: "running" }
const supervisorListeners = new Set<(state: SuperviseStatus) => void>()
const setSupervisorState = (state: SuperviseStatus) => {
  supervisorState = state
  for (const listener of supervisorListeners) {
    try {
      listener(state)
    } catch (error) {
      // One dead window must not stop the others from hearing that the instance is down.
      writeLog("utility", "supervisor state listener failed", { error: String(error) }, "warn")
    }
  }
}
// P6: set once the sidecar is up — lets the updater guard read the machine's offline status.
let sidecarOfflineProbe: (() => Promise<boolean>) | undefined

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.NOVACLAW_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "app.novaclaw.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `novaclaw-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.NOVACLAW_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  // `--home <dir>` / `NOVACLAW_HOME`: run this window as its own instance out of one folder, so several
  // NovaClaws can share a machine. Two things have to happen here, both BEFORE the single-instance lock
  // is requested further down:
  //   · NOVACLAW_HOME goes into the environment, which createSidecarEnv() copies, so the server sidecar
  //     resolves its config/data/state/cache under the same folder (core `util/xdg.ts` reads it);
  //   · userData moves inside that folder — Electron keys its single-instance lock on userData, so
  //     without this the second window would call app.quit() immediately, and both instances would
  //     share window state and settings besides.
  // The argv shape is parsed the same way core's Xdg.homeOverride does it; kept local rather than
  // adding a @novaclaw/core dependency to the main process for six lines.
  const instanceHome = ((): string | undefined => {
    const argv = process.argv
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]
      if (arg === "--home" || arg === "--home-dir") {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("-") && next.trim() !== "") return resolve(next)
        continue
      }
      const eq = /^--home(?:-dir)?=(.*)$/.exec(arg ?? "")
      if (eq?.[1] !== undefined && eq[1].trim() !== "") return resolve(eq[1])
    }
    const fromEnv = process.env.NOVACLAW_HOME
    return fromEnv && fromEnv.trim() !== "" ? resolve(fromEnv) : undefined
  })()
  if (instanceHome) process.env.NOVACLAW_HOME = instanceHome

  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "NovaClaw Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot
      ? join(onboardingTestRoot, "desktop")
      : instanceHome
        ? join(instanceHome, "desktop")
        : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    void stopSidecars().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("novaclaw://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  /**
   * Quit WAITS for the sidecar, bounded.
   *
   * Both handlers used to call `void stopSidecars()`, and Electron does not wait for a floating
   * promise — so the app exited while the sidecar was still being asked to stop, losing anything
   * unflushed on every ordinary quit, silently. (`relaunch()` above already used `.finally()`,
   * which is what makes this a slip rather than a decision.)
   *
   * ⚠️ The opposite failure is worse, so it is bounded three ways: `quitting` lets the second pass
   * through untouched, the timeout races a stuck sidecar, and `app.exit(0)` runs on both branches.
   * An app that will not close is the one thing users answer with a force-kill.
   */
  let quitting = false
  const QUIT_DEADLINE_MS = 5_000
  app.on("before-quit", (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    const forced = new Promise<"forced">((resolve) => setTimeout(() => resolve("forced"), QUIT_DEADLINE_MS))
    void Promise.race([stopSidecars().then(() => "settled" as const), forced])
      .then((outcome) => {
        if (outcome === "forced") writeLog("utility", "quit forced: sidecar did not stop in time", {}, "warn")
      })
      .catch((error) => writeLog("utility", "quit: stopping sidecars failed", { error: String(error) }, "warn"))
      .finally(() => app.exit(0))
  })

  app.on("will-quit", () => {
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  // `Effect.promise` makes a rejection a DEFECT, and nothing downstream was looking for one — so a
  // failed `whenReady` ended the main fiber with no window, no dialog and no log line. It stays a
  // hard stop (nothing can be drawn without a ready Electron), but it now says so.
  const electronReady = yield* Effect.promise(() => app.whenReady()).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        logger.error("electron never became ready", Cause.pretty(cause))
        dialog.showErrorBox("NovaClaw could not start", "Electron did not finish starting up. Please try again.")
        app.exit(1)
        return false
      }),
    ),
  )
  if (!electronReady) return
  markBoot("electron-ready")

  app.setAsDefaultProtocolClient("novaclaw")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    supervisorState: () => supervisorState,
    subscribeSupervisorState: (listener) => {
      supervisorListeners.add(listener)
      return () => supervisorListeners.delete(listener)
    },
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: (serverLogDirectory) => exportDebugLogs(serverLogDirectory),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    // ⚠️ VALIDATED against the vocabulary, not trusted. This arrives over IPC from the renderer, and
    // an unrecognised phase would otherwise enter the timeline and be compared against runs that
    // never had it. The renderer can only report the two phases the main process cannot observe.
    markBootPhase: (phase) => {
      if (phase === "renderer-interactive" || phase === "first-chat-token") markBoot(phase)
    },
  })
  registerWslIpcHandlers(wslServers)
  // Dependability P6: airgap force-off — updater POLLING never runs when offline mode is on
  // (NOVACLAW_OFFLINE, or the sidecar's offline status once it is up — the N/9 source of truth).
  // Manual menu checks stay real attempts. The skip is logged so the gate is provable.
  const pollUpdater = async (kind: "start" | "poll") => {
    const env = process.env.NOVACLAW_OFFLINE
    const airgapped = env === "true" || env === "1" || (sidecarOfflineProbe ? await sidecarOfflineProbe() : false)
    if (airgapped) {
      logger.log("updater check skipped — offline/airgap mode is on", { kind })
      return
    }
    await (kind === "start" ? updater.start() : updater.check())
  }
  // ⚠️ `updater.start()`'s persistence awaits sit outside `check()`'s own `.catch`, and neither
  // call site below had one — an unhandled rejection whose fate under Electron 42's default
  // `--unhandled-rejections` mode is not measured. One catch at the source covers both.
  const pollUpdaterSafely = (kind: "start" | "poll") =>
    void pollUpdater(kind).catch((error: unknown) => logger.warn("updater poll failed", error))
  pollUpdaterSafely("start")
  const updateTimer = setInterval(() => pollUpdaterSafely("poll"), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))

  // Net logging is diagnostics; it must never sit between the user and their window. Forked, and
  // caught with `catchCause` because `Effect.promise` rejects into a defect that `Effect.catch`
  // cannot see (the same mismatch that hid the sidecar crash below).
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catchCause((cause) => Effect.sync(() => logger.warn("failed to start net log", Cause.pretty(cause)))),
    Effect.forkChild,
  )

  // Everything the local server needs, in one effect that runs BEHIND the window.
  //
  // `preferAppEnv` moved in here from before `app.whenReady()`. On macOS/Linux it runs two
  // `spawnSync` login-shell probes at 5 s each, which used to be up to ~10 s of blank screen before
  // anything was drawn. Its only contract is that it runs before `createSidecarEnv()` copies
  // `process.env`, and being the first statement of this effect keeps that exactly.
  /**
   * How many times a LOST PORT RACE may be re-probed before the boot gives up and reports.
   *
   * The race is narrow — the probe binds port 0, reads the number, closes, and the sidecar binds it
   * a moment later — so anything that loses it twice in a row is not a race, it is a machine where
   * something is actively taking ports. Retrying forever there would replace a named failure with a
   * spinner, which is strictly worse.
   */
  const PORT_RACE_ATTEMPTS = 3

  /**
   * Only a lost race is retryable. A sidecar that is broken must fail on the FIRST attempt.
   *
   * ⚠️ And only when the port was PROBED. `NOVACLAW_PORT` is the user pinning a port — re-probing
   * returns that same number, so a retry cannot possibly succeed and would just serve the honest
   * "port N is already in use" three timeouts late. This is the same required/preferred split the
   * server makes, decided on the side that owns the choice.
   */
  const portIsPinned = process.env.NOVACLAW_PORT !== undefined && process.env.NOVACLAW_PORT !== ""
  const isPortRace = (error: unknown): boolean =>
    !portIsPinned && error instanceof Error && error.name === "PortUnavailableError"

  const startSidecar = Effect.gen(function* () {
    // The sidecar track OPENS here. Without this mark the spawn's duration had to be inferred from
    // whatever mark happened to precede it in time — and since the renderer runs concurrently, that
    // was usually a renderer mark, producing a number that measured neither. See PHASE_TRACK.
    markBoot("sidecar-start")
    preferAppEnv(app.getPath("userData"))

    const probePort = Effect.gen(function* () {
      const fromEnv = process.env.NOVACLAW_PORT
      if (fromEnv) {
        const parsed = Number.parseInt(fromEnv, 10)
        if (!Number.isNaN(parsed)) return parsed
      }

      const res = yield* Deferred.make<number, unknown>()
      const server = createServer()
      server.on("error", (e) => Deferred.failSync(res, () => e))
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (typeof address !== "object" || !address) {
          server.close()
          Deferred.failSync(res, () => new Error("Failed to get port"))
          return
        }
        const port = address.port
        server.close(() => Effect.runSync(Deferred.succeed(res, port)))
      })

      return yield* Deferred.await(res)
      // ⚠️ Neither callback is guaranteed to fire (a broken loopback stack answers neither), and an
      // un-deadlined Deferred.await is a silent hang. Bounded, so it becomes the renderer's named
      // "could not start the local server" page instead of a splash that never ends.
    }).pipe(Effect.timeout("10 seconds"))

    const hostname = "127.0.0.1"
    const password = randomUUID()

    ensureLoopbackNoProxy()
    useEnvProxy()

    /**
     * Probe a port, spawn on it, and **re-probe if the race was lost**.
     *
     * The probe binds port 0, reads the number, closes the socket, and the sidecar binds it a moment
     * later. Anything may take it in that gap, and losing that race used to end the boot outright:
     * the child reported `PortUnavailableError`, the spawn rejected, and the user got a "could not
     * start the local server" page for a transient collision that a second probe would have avoided.
     *
     * ⛔ The fix is NOT `portIntent: "preferred"` in the sidecar. The main process owns `url` and
     * builds it from the port it probed; the sidecar's ready message carries no port, so letting the
     * CHILD fall back yields a server nobody talks to — a silent failure replacing a loud one.
     *
     * ✅ Retrying HERE is safe precisely because this runs before `serverReady` is resolved, so a
     * changed port is invisible to the renderer: no stale URL, no republish protocol. Only a
     * POST-ready respawn would need that, and the supervisor reuses a port already proven bindable.
     *
     * ⚠️ Retries only on a lost race (`isPortRace`). A broken sidecar must fail on the first attempt
     * — retrying it three times would turn a prompt, named error into a long wait for the same one.
     */
    const startOn = Effect.gen(function* () {
      const port = yield* probePort
      const url = `http://${hostname}:${port}`
      logger.log("sidecar connection started", { url })
      logger.log("spawning sidecar", { url })
      // P3: supervised — a sidecar that dies after boot is respawned with backoff (crash loops give
      // up gracefully and the renderer's connection banner reports the outage).
      const supervised = yield* Effect.tryPromise({
        try: () =>
          superviseLocalServer(hostname, port, password, {
            onStdout: (message) => writeLog("server", "stdout", { message }),
            onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
            onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
            onState: (state) => {
              writeLog("utility", "supervisor state", { ...state }, state.phase === "gave-up" ? "error" : "info")
              setSupervisorState(state)
            },
          }),
        catch: (cause) => cause,
      })
      markBoot("sidecar-spawned")
      return { port, url, ...supervised }
    })

    const { port, url, listener, health } = yield* startOn.pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          if (isPortRace(cause)) writeLog("utility", "sidecar lost the port race — re-probing", {}, "warn")
        }),
      ),
      Effect.retry({ while: isPortRace, schedule: Schedule.recurs(PORT_RACE_ATTEMPTS - 1) }),
      // Exhausted, or never retryable: this is the boot failing, and `forwardInitializationFailure`
      // turns it into the renderer's named page rather than a splash that never ends.
      Effect.catch((cause) => Effect.die(cause)),
    )
    server = listener
    sidecarOfflineProbe = () => checkOfflineEnabled(url, password, app.getPath("home"))
    yield* Deferred.succeed(serverReady, {
      url,
      username: "novaclaw",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    // ⚠️ `tryPromise` + `catchCause`, and both halves matter. `health.wait` REJECTS when the child
    // dies mid-startup ("Sidecar exited before health check passed with code …"); under
    // `Effect.promise` that rejection was a defect, and the `Effect.catch` that used to sit here
    // does not see defects — so the crash arm was logged nowhere at all while the timeout arm was
    // handled correctly. The credentials are already published above, so the renderer's connection
    // banner owns the user-visible half; this handler owns naming the reason.
    yield* Effect.tryPromise({ try: () => health.wait, catch: (error) => error }).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const failure = describeSidecarFailure(cause, "health")
          logger.error("sidecar health check failed", {
            kind: failure.kind,
            summary: failure.summary,
            detail: failure.detail,
          })
        }),
      ),
    )

    markBoot("sidecar-health")
    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady))

  yield* bootWindowFirst({
    openWindow: () => {
      const win = createMainWindow()
      mainWindow = win
      // A window EXISTS. Deliberately not "the user can use it" — that is `renderer-interactive`,
      // which the renderer reports, and the gap between the two is the number worth having.
      markBoot("window-shown")
      createMenu({
        trigger: (id) => {
          const focused = BrowserWindow.getFocusedWindow() ?? mainWindow
          if (focused) sendMenuCommand(focused, id)
        },
        checkForUpdates: () => {
          void showUpdaterDialog(updater, true)
        },
        relaunch: () => {
          relaunch()
        },
      })

      // Ruling 2, at the one point where it can actually be said: if the profile folder refused
      // every log destination there is no log for anyone to read afterwards, so the window that
      // now exists carries the sentence instead.
      const notice = logDirectoryNotice(getLogDirectory())
      if (notice)
        void dialog
          .showMessageBox(win, {
            type: "warning",
            buttons: ["Continue"],
            defaultId: 0,
            message: notice.summary,
            detail: notice.detail,
          })
          .catch(() => undefined)

      return win
    },
    onWindowFailed: (notice) => {
      logger.error(notice.summary, notice.detail)
      dialog.showErrorBox("NovaClaw could not start", `${notice.summary}\n\n${notice.detail}`)
    },
    sidecar: startSidecar,
    onSidecarSettled: (exit) => {
      if (Exit.isSuccess(exit)) return
      const failure = describeSidecarFailure(exit.cause, "startup")
      logger.error("local server startup failed", {
        kind: failure.kind,
        summary: failure.summary,
        detail: failure.detail,
      })
    },
  })
})

Effect.runFork(main)
