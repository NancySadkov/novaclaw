import { app, dialog } from "electron"
import { desktopExecutableName, desktopHelp, desktopOptionError, parseDesktopInvocation } from "./desktop-cli"

const executable = desktopExecutableName(process.execPath)
const invocation = parseDesktopInvocation(process.argv)

if (invocation.action === "help") {
  process.stdout.write(desktopHelp(executable))
  app.exit(0)
} else if (invocation.action === "error") {
  process.stderr.write(desktopOptionError(executable, invocation.message))
  app.exit(2)
} else {
  void import("./application")
    .then(({ runDesktop }) => runDesktop())
    .catch((error) => {
      console.error("Desktop startup failed", error)
      dialog.showErrorBox("NovaClaw could not start", "Desktop startup failed. Please try again.")
      app.exit(1)
    })
}
