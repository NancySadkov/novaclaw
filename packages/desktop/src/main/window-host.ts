import { BrowserWindow, dialog } from "electron"
import { createMainWindow } from "./windows"
import { createMenu } from "./menu"
import { sendDeepLinks, sendMenuCommand, sendRecipePackages } from "./ipc"
import type { OpenedRecipePackage } from "./recipe-package-open"
import { getLogDirectory } from "./logging"
import { logDirectoryNotice } from "./log-directory"

/** Owns the window reference and links arriving before its renderer is listening. */
export function createWindowHost(relaunch: () => void, requestClose?: () => void) {
  let current: BrowserWindow | undefined
  const pendingLinks: string[] = []
  const pendingPackages: OpenedRecipePackage[] = []
  let packagesConsumed = false
  return {
    open() {
      const window = createMainWindow()
      current = window
      if (requestClose) window.on("close", (event) => {
        event.preventDefault()
        requestClose()
      })
      window.webContents.on("did-start-loading", () => { packagesConsumed = false })
      window.once("closed", () => {
        if (current === window) current = undefined
      })
      createMenu({
        trigger: (id) => {
          const focused = BrowserWindow.getFocusedWindow() ?? current
          if (focused) sendMenuCommand(focused, id)
        },
        relaunch,
      })
      const notice = logDirectoryNotice(getLogDirectory())
      if (notice)
        void dialog
          .showMessageBox(window, {
            type: "warning",
            buttons: ["Continue"],
            defaultId: 0,
            message: notice.summary,
            detail: notice.detail,
          })
          .catch(() => undefined)
    },
    focus() {
      current?.show()
      current?.focus()
    },
    current: () => current,
    links(urls: string[]) {
      pendingLinks.push(...urls)
      if (current && urls.length) sendDeepLinks(current, urls)
    },
    consumeLinks: () => pendingLinks.splice(0),
    packages(packages: OpenedRecipePackage[]) {
      if (packagesConsumed && current) sendRecipePackages(current, packages)
      else pendingPackages.push(...packages)
    },
    consumePackages: () => {
      packagesConsumed = true
      return pendingPackages.splice(0)
    },
  }
}
