import { app, BrowserWindow, dialog } from "electron"
import contextMenu from "electron-context-menu"
import { Cause } from "effect"
import { checkAppExists, resolveAppPath } from "./apps"
import { describeSidecarFailure } from "./boot"
import { offerBootRecovery } from "./boot-recovery-host"
import { createDesktopDiagnostics } from "./diagnostics"
import { readRecipePackage, recipePackagePaths } from "./recipe-package-open"
import { prepareInstanceHome } from "./instance-home"
import { registerIpcHandlers } from "./ipc"
import { createDesktopLifecycle } from "./lifecycle"
import { isTitlebarContextMenu } from "./titlebar-context-menu"
import { createDesktopService } from "./desktop-service"
import { exportDebugLogs, startNetLog, write as writeLog } from "./logging"
import { prepareProcessEnvironment } from "./process-environment"
import { getDefaultServerUrl, setDefaultServerUrl } from "./server"
import { createWindowHost } from "./window-host"
import { registerRendererProtocol, setBackgroundColor, setDockIcon, setRelaunchHandler } from "./windows"
import { createWslInstanceHost } from "./wsl-instance"
import type { DesktopLaunchOptions } from "./desktop-cli"
import type { LocalInstanceOwner } from "./lifecycle"
import type { ServerReadyData } from "../preload/types"
import type { SuperviseStatus } from "@novaclaw/script/supervise"

/** Electron is an adapter to the lifecycle. The owners below are constructed before they can start;
 * no callback has to wait for a module-level window, listener or shutdown function to appear. */
export async function runDesktop(options: DesktopLaunchOptions) {
  const home = prepareInstanceHome("client", options.mode === "both")
  const diagnostics = createDesktopDiagnostics()
  const { logger, mark } = diagnostics
  contextMenu({
    showSaveImageAs: true,
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    shouldShowMenu: (_event, properties) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return true
      const bounds = win.getContentBounds()
      return !isTitlebarContextMenu(properties.y, bounds.width, bounds.height, win.webContents.getZoomFactor())
    },
  })
  prepareProcessEnvironment(logger)
  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: home.onboardingTest,
  })
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const wsl = createWslInstanceHost(app.getVersion(), logger)
  const openPackages = async (paths: readonly string[]) => {
    for (const filePath of paths) {
      try {
        window.packages([await readRecipePackage(filePath)])
      } catch (error) {
        logger.error("could not open recipe package", { filePath, error: String(error) })
      }
    }
  }
  const local =
    options.mode === "client"
      ? createConnectedInstance(options.connect!)
      : createDesktopService(home, options.server)
  // Menu/window callbacks are invoked only after lifecycle construction; unlike the old mutable
  // relaunch callback, they always reach this same owner and the same shutdown promise.
  const window = createWindowHost(() => {
    void quit(true, 0, true)
  }, () => { void requestClose() })
  const lifecycle: ReturnType<typeof createDesktopLifecycle> = createDesktopLifecycle({
    electronReady: async () => {
      await app.whenReady()
      mark("electron-ready")
      app.setAsDefaultProtocolClient("novaclaw")
      registerRendererProtocol()
      setDockIcon()
      await wsl.prepare()
      registerIpcHandlers({
        killSidecar: () => local.stop(),
        supervisorState: local.state,
        subscribeSupervisorState: local.subscribe,
        relaunch: () => {
          void quit(true, 0, true)
        },
        awaitInitialization: lifecycle.awaitInitialization,
        consumeInitialDeepLinks: window.consumeLinks,
        consumeInitialRecipePackages: window.consumePackages,
        getDefaultServerUrl: () => (options.mode === "client" ? null : getDefaultServerUrl()),
        setDefaultServerUrl,
        getDisplayBackend: async () => null,
        setDisplayBackend: async () => undefined,
        checkAppExists,
        resolveAppPath: async (name) => resolveAppPath(name),
        setBackgroundColor: (color) => setBackgroundColor(color),
        exportDebugLogs: (serverDiagnostics) => exportDebugLogs(serverDiagnostics),
        recordFatalRendererError: (error) => {
          writeLog("renderer", "fatal renderer error", { ...error }, "error")
        },
        markBootPhase: (phase) => {
          if (phase === "renderer-interactive" || phase === "first-chat-token") mark(phase)
        },
      })
    },
    openWindow: window.open,
    local,
    instances: [wsl],
    afterWindow: () => {
      void startNetLog().catch((error) => logger.warn("failed to start net log", error))
    },
    afterCredentials: () => wsl.initialize(),
    phase: (phase) => {
      if (phase === "window-open") mark("window-shown")
      if (phase === "sidecar-spawned") mark("sidecar-spawned")
      if (phase === "sidecar-healthy") {
        mark("sidecar-health")
        logger.log("loading task finished")
      }
    },
    failure: (error, stage) => {
      if (stage === "electron" || stage === "window") {
        logger.error("desktop initialization failed", { stage, error: String(error) })
        dialog.showErrorBox(
          "NovaClaw could not start",
          stage === "electron"
            ? "Electron did not finish starting up. Please try again."
            : "NovaClaw could not open its window. Please try again.",
        )
        void quit(false, 1)
        return
      }
      const failure = describeSidecarFailure(Cause.fail(error), stage === "health" ? "health" : "startup")
      logger.error("local server failed", {
        stage,
        kind: failure.kind,
        summary: failure.summary,
        detail: failure.detail,
      })
      if (stage === "startup") void offerBootRecovery(failure, quit)
    },
  })
  let exiting: Promise<void> | undefined
  let closePrompt: Promise<void> | undefined
  function requestClose(): Promise<void> {
    if (exiting) return exiting
    if (closePrompt) return closePrompt
    const current = window.current()
    if (!current) return quit(false, 0)
    return (closePrompt = dialog.showMessageBox(current, {
      type: "question",
      title: "Close NovaClaw",
      message: "What should NovaClaw do with its server?",
      detail: "Keeping the server running lets agents continue working while the desktop is closed.",
      buttons: options.mode === "client" ? ["Cancel", "Close"] : ["Cancel", "Close", "Retain server in background"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(async ({ response }) => {
      if (response === 1) return quit(false, 0)
      if (response === 2) {
        try {
          await lifecycle.awaitInitialization()
          return quit(false, 0, true)
        } catch (error) {
          logger.error("cannot retain a server that did not start", { error: String(error) })
          dialog.showErrorBox("NovaClaw is still starting", "The server is not ready to run in the background.")
        }
      }
    }).catch((error) => {
      logger.error("close prompt failed", { error: String(error) })
    }).finally(() => { closePrompt = undefined }))
  }
  function quit(relaunch: boolean, code: number, retain = false): Promise<void> {
    if (exiting) return exiting
    if (retain && "retain" in local && typeof local.retain === "function") local.retain()
    return (exiting = lifecycle
      .quit()
      .then((result) => {
        if (result.outcome === "forced")
          writeLog("utility", "quit forced: an instance did not stop in time", {}, "warn")
        for (const error of result.failures)
          writeLog("utility", "quit: stopping an instance failed", { error: String(error) }, "warn")
      })
      .finally(() => {
        if (relaunch) app.relaunch()
        app.exit(code)
      }))
  }
  app.on("before-quit", (event) => {
    event.preventDefault()
    void requestClose()
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void quit(false, 0)
    })
  setRelaunchHandler(() => {
    void quit(true, 0, true)
  })
  app.on("second-instance", (_event, argv) => {
    window.links(argv.filter((arg) => arg.startsWith("novaclaw://")))
    void openPackages(recipePackagePaths(argv))
    window.focus()
  })
  app.on("open-file", (event, filePath) => {
    event.preventDefault()
    void openPackages([filePath])
    window.focus()
  })
  app.on("open-url", (event, url) => {
    event.preventDefault()
    window.links([url])
  })
  await lifecycle.run()
  await openPackages(recipePackagePaths(process.argv))
}

/** A client-only launch has an instance owner too; it owns credentials, not a child process. */
function createConnectedInstance(connect: NonNullable<DesktopLaunchOptions["connect"]>): LocalInstanceOwner & {
  state(): SuperviseStatus
  subscribe(listener: (state: SuperviseStatus) => void): () => void
} {
  const credentials: ServerReadyData = {
    url: connect.url,
    username: connect.username ?? null,
    password: connect.password ?? null,
  }
  return {
    state: () => ({ phase: "running" }),
    subscribe: () => () => undefined,
    start: async (signal) => {
      signal.throwIfAborted()
      return { credentials, healthy: Promise.resolve() }
    },
    stop: async () => undefined,
  }
}
