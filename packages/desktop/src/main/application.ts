import { app, dialog } from "electron"
import contextMenu from "electron-context-menu"
import { Cause } from "effect"
import { checkAppExists, resolveAppPath } from "./apps"
import { describeSidecarFailure } from "./boot"
import { offerBootRecovery } from "./boot-recovery-host"
import { createDesktopDiagnostics } from "./diagnostics"
import { prepareInstanceHome } from "./instance-home"
import { registerIpcHandlers } from "./ipc"
import { createDesktopLifecycle } from "./lifecycle"
import { createLocalInstance } from "./local-instance"
import { exportDebugLogs, startNetLog, write as writeLog } from "./logging"
import { prepareLocalEnvironment, prepareProcessEnvironment } from "./process-environment"
import { getDefaultServerUrl, setDefaultServerUrl, superviseLocalServer } from "./server"
import { createWindowHost } from "./window-host"
import { registerRendererProtocol, setBackgroundColor, setDockIcon, setRelaunchHandler } from "./windows"
import { createWslInstanceHost } from "./wsl-instance"

/** Electron is an adapter to the lifecycle. The owners below are constructed before they can start;
 * no callback has to wait for a module-level window, listener or shutdown function to appear. */
export async function runDesktop() {
  const home = prepareInstanceHome()
  const diagnostics = createDesktopDiagnostics()
  const { logger, mark } = diagnostics
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })
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
  const local = createLocalInstance({
    prepare: () => {
      mark("sidecar-start")
      prepareLocalEnvironment(logger)
    },
    pinnedPort: process.env.NOVACLAW_PORT,
    log: (message, metadata) => logger.log(message, metadata),
    spawn: (port, password, signal, report) =>
      superviseLocalServer("127.0.0.1", port, password, {
        signal,
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
        onState: (state) => {
          writeLog("utility", "supervisor state", { ...state }, state.phase === "gave-up" ? "error" : "info")
          report(state)
        },
      }),
  })
  // Menu/window callbacks are invoked only after lifecycle construction; unlike the old mutable
  // relaunch callback, they always reach this same owner and the same shutdown promise.
  const window = createWindowHost(() => {
    void quit(true, 0)
  })
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
          void quit(true, 0)
        },
        awaitInitialization: lifecycle.awaitInitialization,
        consumeInitialDeepLinks: window.consumeLinks,
        getDefaultServerUrl,
        setDefaultServerUrl,
        getDisplayBackend: async () => null,
        setDisplayBackend: async () => undefined,
        checkAppExists,
        resolveAppPath: async (name) => resolveAppPath(name),
        setBackgroundColor: (color) => setBackgroundColor(color),
        exportDebugLogs: (serverDiagnostics) => exportDebugLogs(serverDiagnostics),
        recordFatalRendererError: (error) => {
          writeLog("renderer", "fatal renderer error", { ...error }, "error")
          diagnostics.captureFailure("renderer-fatal-error")
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
  function quit(relaunch: boolean, code: number): Promise<void> {
    if (exiting) return exiting
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
    void quit(false, 0)
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void quit(false, 0)
    })
  setRelaunchHandler(() => {
    void quit(true, 0)
  })
  app.on("second-instance", (_event, argv) => {
    window.links(argv.filter((arg) => arg.startsWith("novaclaw://")))
    window.focus()
  })
  app.on("open-url", (event, url) => {
    event.preventDefault()
    window.links([url])
  })
  await lifecycle.run()
}
