import { app, dialog } from "electron"
import { runDesktop } from "./application"

void runDesktop().catch((error) => {
  console.error("Desktop startup failed", error)
  dialog.showErrorBox("NovaClaw could not start", "Desktop startup failed. Please try again.")
  app.exit(1)
})
