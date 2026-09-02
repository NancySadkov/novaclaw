import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type { SuperviseStatus } from "@novaclaw/script/supervise"
import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { createSaveFileAuthorizations, parseSavePickerOptions } from "./save-picker"
import { getStore, isStoreName } from "./store"
import { getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import { createSubscriptions } from "./subscriptions"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

/**
 * The renderer names the store, and that name IS the store's file path (see `store.ts`). Two
 * separate things have to be true at this boundary, which is why the check is here and not only
 * inside `getStore`:
 *
 *  1. the name is in the closed vocabulary — otherwise `path.resolve` takes an absolute name or a
 *     `..` name straight out of `userData`;
 *  2. the renderer actually SUPPLIED one. `getStore(name = SETTINGS_STORE)` cannot tell an omitted
 *     argument from an explicit `undefined`, so a renderer that sends no name would otherwise be
 *     handed `novaclaw.settings` — the main process's own store, holding the default server URL and
 *     the WSL server list. The vocabulary check alone does not catch that; insisting on a string
 *     does.
 */
const openStore = (name: unknown) => {
  if (isStoreName(name)) return getStore(name)
  // Described by type, not by value: IPC can carry a cyclic object, and `JSON.stringify` on one
  // would throw a "circular structure" TypeError in place of the refusal that is the actual answer.
  throw new Error(`Refused store name: ${typeof name === "string" ? JSON.stringify(name) : typeof name}`)
}

const pickedFiles = createPickedFileAuthorizations()
const pickedSaves = createSaveFileAuthorizations()
const saveCleanupSenders = new WeakSet<object>()

type Deps = {
  killSidecar: () => Promise<void> | void
  /**
   * The sidecar supervisor's live phase, and a push subscription for its transitions.
   *
   * ⚠️ Read on demand rather than cached in the renderer: the state that matters most (`gave-up`)
   * is reached while the server is DOWN, so it cannot travel over the instance's own HTTP surface
   * and a renderer that reloaded after the outage would otherwise start with no idea it happened.
   */
  supervisorState: () => SuperviseStatus
  subscribeSupervisorState: (listener: (state: SuperviseStatus) => void) => () => void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  setBackgroundColor: (color: string) => void
  exportDebugLogs: (serverDiagnostics?: string) => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  /**
   * The renderer reporting a boot phase only IT can see — first paint, and the first chat token.
   * One-way and best-effort: a mark that never arrives is reported as MISSING by the timeline, which
   * is the honest outcome, and no boot may ever be delayed or failed by its own instrumentation.
   */
  markBootPhase: (phase: string) => void
}

export function registerIpcHandlers(deps: Deps) {
  const supervisorSubscriptions = createSubscriptions()
  app.once("will-quit", supervisorSubscriptions.clear)

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("supervisor-get-state", () => deps.supervisorState())
  ipcMain.handle("supervisor-subscribe", (event) => {
    const id = event.sender.id
    supervisorSubscriptions.set(
      id,
      deps.subscribeSupervisorState((state) => {
        if (event.sender.isDestroyed()) return supervisorSubscriptions.delete(id)
        event.sender.send("supervisor-state", state)
      }),
    )
    event.sender.once("destroyed", () => supervisorSubscriptions.delete(id))
    // The current phase, immediately: a window that opens mid-outage must not wait for the next
    // transition to learn there is one — and after `gave-up` there is no next transition at all.
    event.sender.send("supervisor-state", deps.supervisorState())
  })
  ipcMain.handle("supervisor-unsubscribe", (event) => supervisorSubscriptions.delete(event.sender.id))
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", (_event: IpcMainInvokeEvent, serverDiagnostics?: string) =>
    deps.exportDebugLogs(serverDiagnostics),
  )
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.on("mark-boot-phase", (_event: IpcMainEvent, phase: string) => deps.markBootPhase(phase))
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: unknown, key: string) => {
    // ⚠️ `openStore` throws OUTSIDE the catch below on purpose. That catch tolerates an unreadable
    // store file; a refused NAME is a different thing, and swallowing it would present a legitimate
    // name that someone forgot to add to the vocabulary as an empty store — which the next write
    // would then make permanent.
    const store = openStore(name)
    try {
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: unknown, key: string, value: string) => {
    openStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: unknown, key: string) => {
    openStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: unknown) => {
    openStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: unknown) => {
    return Object.keys(openStore(name).store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: unknown) => {
    return Object.keys(openStore(name).store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle("save-file-picker", async (event: IpcMainInvokeEvent, input?: unknown) => {
    const opts = parseSavePickerOptions(input)
    const result = await dialog.showSaveDialog({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    })
    if (result.canceled) return null
    const filePath = result.filePath
    if (!filePath) return null
    const sender = event.sender
    if (!saveCleanupSenders.has(sender)) {
      saveCleanupSenders.add(sender)
      const senderID = sender.id
      sender.once("destroyed", () => pickedSaves.releaseSender(senderID))
    }
    return { token: pickedSaves.add(sender.id, filePath), path: filePath }
  })

  ipcMain.handle("write-picked-file", (event: IpcMainInvokeEvent, token: unknown, content: unknown) => {
    return pickedSaves.write(event.sender.id, token, content)
  })

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.handle("read-clipboard-text", () => clipboard.readText())
  ipcMain.handle("write-clipboard-text", (_event: IpcMainInvokeEvent, text: string) => {
    if (typeof text !== "string") throw new TypeError("Clipboard text must be a string")
    clipboard.writeText(text)
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
