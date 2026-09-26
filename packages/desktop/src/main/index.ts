import { app, dialog } from "electron"
import { desktopExecutableName, desktopHelp, desktopOptionError, parseDesktopInvocation } from "./desktop-cli"

const executable = desktopExecutableName(process.execPath)
const invocation = parseDesktopInvocation(process.argv)

if (invocation.action === "help") {
  process.stdout.write(desktopHelp(executable))
  app.exit(0)
} else if (invocation.action === "version") {
  process.stdout.write(`${app.getVersion()}\n`)
  app.exit(0)
} else if (invocation.action === "error") {
  process.stderr.write(desktopOptionError(executable, invocation.message))
  app.exit(2)
} else {
  const entry =
    invocation.options.mode === "server"
      ? invocation.options.desktopService
        ? import("./headless-server").then(({ runHeadlessServer }) => runHeadlessServer(invocation.options))
        : import("./server-only-launcher").then(({ runServerOnlyLauncher }) => runServerOnlyLauncher(invocation.options))
      : import("./application").then(({ runDesktop }) => runDesktop(invocation.options))
  void entry
    .catch((error) => {
      if (invocation.options.mode === "server") {
        process.stderr.write(`NovaClaw server failed: ${error instanceof Error ? error.message : String(error)}\n`)
      } else {
        console.error("Desktop startup failed", error)
        dialog.showErrorBox("NovaClaw could not start", "Desktop startup failed. Please try again.")
      }
      app.exit(1)
    })
}
