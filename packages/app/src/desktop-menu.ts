// The macOS native menu-bar definition (consumed by the Electron main process in
// packages/desktop/src/main/menu.ts). Windows/Linux have no app menu: the in-titlebar
// hamburger menu was retired 2026-07-22 — its entries pointed at commands the launcher
// redesign removed; everything lives in the HTML shell (launcher tiles, Chats, Settings).
//
// INVARIANT: this menu is built ONCE at app startup and never reflects renderer state, so an
// entry may only reference (a) a native Electron role, (b) a main-process DesktopMenuAction,
// or (c) a command that is registered on EVERY route — i.e. from NewLayout or the Titlebar,
// never from a page. A page-scoped command here silently no-ops whenever its page is closed.
export type DesktopMenuAction =
  | "app.checkForUpdates"
  | "app.relaunch"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.delete"
  | "edit.selectAll"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.resetZoom"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.toggleFullscreen"
  | "window.new"
  | "window.close"
  | "window.minimize"
  | "window.toggleMaximize"

export type DesktopMenuRole =
  | "about"
  | "close"
  | "copy"
  | "cut"
  | "hide"
  | "hideOthers"
  | "paste"
  | "quit"
  | "redo"
  | "reload"
  | "resetZoom"
  | "selectAll"
  | "toggleDevTools"
  | "togglefullscreen"
  | "undo"
  | "unhide"
  | "windowMenu"
  | "zoomIn"
  | "zoomOut"

export type DesktopMenuItem = {
  type: "item"
  label?: string
  command?: string
  action?: DesktopMenuAction
  role?: DesktopMenuRole
  href?: string
  accelerator?: string
  enabled?: "updater"
}

export type DesktopMenuSeparator = {
  type: "separator"
}

export type DesktopMenuEntry = DesktopMenuItem | DesktopMenuSeparator

export type DesktopMenu = {
  id: string
  label: string
  role?: DesktopMenuRole
  items?: DesktopMenuEntry[]
}

export const DESKTOP_MENU: DesktopMenu[] = [
  {
    id: "app",
    label: "NovaClaw",
    items: [
      { type: "item", role: "about" },
      { type: "item", label: "Check for Updates...", action: "app.checkForUpdates", enabled: "updater" },
      { type: "item", label: "Settings", command: "settings.open", accelerator: "Cmd+," },
      { type: "item", label: "Reload Webview", action: "view.reload" },
      { type: "item", label: "Restart", action: "app.relaunch" },
      { type: "item", label: "Export Logs...", command: "logs.export" },
      { type: "separator" },
      { type: "item", role: "hide" },
      { type: "item", role: "hideOthers" },
      { type: "item", role: "unhide" },
      { type: "separator" },
      { type: "item", role: "quit" },
    ],
  },
  {
    id: "file",
    label: "File",
    items: [
      {
        type: "item",
        label: "New Window",
        action: "window.new",
        accelerator: "Cmd+Shift+N",
      },
      { type: "separator" },
      { type: "item", label: "Close Window", action: "window.close", role: "close" },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    items: [
      { type: "item", label: "Undo", action: "edit.undo", role: "undo" },
      { type: "item", label: "Redo", action: "edit.redo", role: "redo" },
      { type: "separator" },
      { type: "item", label: "Cut", action: "edit.cut", role: "cut" },
      { type: "item", label: "Copy", action: "edit.copy", role: "copy" },
      { type: "item", label: "Paste", action: "edit.paste", role: "paste" },
      { type: "item", label: "Delete", action: "edit.delete" },
      {
        type: "item",
        label: "Select All",
        action: "edit.selectAll",
        role: "selectAll",
      },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      { type: "item", label: "Reload", action: "view.reload", role: "reload" },
      { type: "item", label: "Toggle Developer Tools", action: "view.toggleDevTools", role: "toggleDevTools" },
      { type: "separator" },
      {
        type: "item",
        label: "Actual Size",
        action: "view.resetZoom",
        role: "resetZoom",
      },
      { type: "item", label: "Zoom In", action: "view.zoomIn", role: "zoomIn" },
      { type: "item", label: "Zoom Out", action: "view.zoomOut", role: "zoomOut" },
      { type: "separator" },
      { type: "item", label: "Toggle Full Screen", action: "view.toggleFullscreen", role: "togglefullscreen" },
    ],
  },
  {
    id: "go",
    label: "Go",
    items: [
      { type: "item", label: "Back", command: "common.goBack", accelerator: "Cmd+[" },
      { type: "item", label: "Forward", command: "common.goForward", accelerator: "Cmd+]" },
      { type: "separator" },
      { type: "item", label: "Previous Tab", command: "tab.prev", accelerator: "Ctrl+Shift+Tab" },
      { type: "item", label: "Next Tab", command: "tab.next", accelerator: "Ctrl+Tab" },
      { type: "separator" },
      // No Cmd+B accelerator on Home: the legacy layout binds mod+b to its sidebar toggle and a
      // menu accelerator would intercept the key before the renderer sees it. mod+b still works
      // in the new layout via the renderer keybind on home.toggle.
      { type: "item", label: "Home", command: "home.toggle" },
      { type: "item", label: "The Chat That Needs You", command: "chats.jumpToAttention", accelerator: "Cmd+J" },
    ],
  },
  {
    id: "window",
    label: "Window",
    role: "windowMenu",
    items: [
      { type: "item", label: "Minimize", action: "window.minimize" },
      { type: "item", label: "Maximize", action: "window.toggleMaximize" },
      { type: "separator" },
      { type: "item", label: "Close Window", action: "window.close" },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      { type: "item", label: "NovaClaw Documentation", href: "https://novaclaw.app/docs" },
      { type: "item", label: "Export Logs...", command: "logs.export" },
    ],
  },
]
