import { BrowserWindow, Menu, shell } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { DESKTOP_MENU, type DesktopMenuEntry, type DesktopMenuRole } from "@novaclaw/app/desktop-menu"

import { runDesktopMenuAction } from "./desktop-menu-actions"

type Deps = {
  trigger: (id: string) => void
  relaunch: () => void
}

export function createMenu(deps: Deps) {
  if (process.platform !== "darwin") {
    // NovaClaw's interface is the HTML shell. Electron's unused default menu steals Alt on
    // Windows/Linux (including Alt+Shift layout switching) for a developer surface we do not ship.
    Menu.setApplicationMenu(null)
    return
  }

  const template = DESKTOP_MENU.map((menu) => {
    if (menu.role) return { role: nativeRole(menu.role) }
    return {
      label: menu.label,
      submenu: menu.items?.map((entry) => nativeItem(entry, deps)),
    }
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function nativeItem(entry: DesktopMenuEntry, deps: Deps): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  if (entry.role) return { role: nativeRole(entry.role) }

  const item: MenuItemConstructorOptions = {
    label: entry.label,
    accelerator: entry.accelerator,
  }

  if (entry.command) {
    const command = entry.command
    item.click = () => deps.trigger(command)
  }
  if (entry.action) {
    const action = entry.action
    item.click = () =>
      runDesktopMenuAction(BrowserWindow.getFocusedWindow(), action, {
        relaunch: deps.relaunch,
      })
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => shell.openExternal(href)
  }

  return item
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}
