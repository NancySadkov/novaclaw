import { BrowserWindow, dialog } from "electron"
import { createMainWindow } from "./windows"
import { createMenu } from "./menu"
import { sendDeepLinks, sendMenuCommand } from "./ipc"
import { getLogDirectory } from "./logging"
import { logDirectoryNotice } from "./log-directory"

/** Owns the window reference and links arriving before its renderer is listening. */
export function createWindowHost(relaunch: () => void) {
  let current: BrowserWindow | undefined
  const pendingLinks: string[] = []
  return {
    open() {
      const window = createMainWindow()
      current = window
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
    links(urls: string[]) {
      pendingLinks.push(...urls)
      if (current && urls.length) sendDeepLinks(current, urls)
    },
    consumeLinks: () => pendingLinks.splice(0),
  }
}
