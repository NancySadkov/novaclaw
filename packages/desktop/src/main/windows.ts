import windowState from "electron-window-state"
import { resolveThemeVariant } from "@novaclaw/ui/theme/resolve"
import type { DesktopTheme } from "@novaclaw/ui/theme/types"
import novaThemeJson from "../../../ui/src/theme/themes/nova.json"
import { app, BrowserWindow, dialog, net, nativeImage, nativeTheme, protocol, shell } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { CSP_HEADER, rendererCsp } from "./csp"
import { THEME_PRELOAD_SHA256 } from "./constants"
import { HTML_EMBED_CSP, isHtmlEmbedDocument } from "@novaclaw/schema/html-embed"
import { exportDebugLogs, write as writeLog } from "./logging"
import {
  createNavigationGuard,
  isRendererUrl as isRendererUrlFor,
  RENDERER_HOST,
  RENDERER_PROTOCOL,
} from "./navigation"
import { resolveRendererDevUrl } from "./renderer-url"
import { getStore } from "./store"
import { PINCH_ZOOM_ENABLED_KEY } from "./store-keys"
import { createUnresponsiveSampler } from "./unresponsive"
import { preloadFailureRecovery } from "./preload-recovery"

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const rendererProtocol = RENDERER_PROTOCOL
const rendererHost = RENDERER_HOST
const clipboardWritePermission = "clipboard-sanitized-write"
const notificationPermission = "notifications"
const rendererPermissions = new Set([clipboardWritePermission, notificationPermission])
const novaTheme = novaThemeJson as DesktopTheme
const novaBackground = {
  light: resolveThemeVariant(novaTheme.light, false)["background-base"],
  dark: resolveThemeVariant(novaTheme.dark, true)["background-base"],
}
/**
 * The renderer policy, serialized once (NC-SEC-033).
 *
 * ⚠️ Lazily, not at module load. `windows.ts` is imported for many reasons, and `rendererCsp` throws
 * on an empty theme-preload hash — a throw during module evaluation would surface as an unrelated
 * startup failure rather than as the header decision it actually is.
 */
let rendererCspCache: string | undefined
const RENDERER_CSP = () => (rendererCspCache ??= rendererCsp(THEME_PRELOAD_SHA256))

const documentPolicyHeader = "Document-Policy"
const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"
export const PRELOAD_READY_TIMEOUT_MS = 15_000

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
])

let backgroundColor: string | undefined
let relaunchHandler = () => {
  app.relaunch()
  app.exit(0)
}
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const titlebarHeight = 40
const maxZoomLevel = 10
const minZoomLevel = 0.2

export function setRelaunchHandler(handler: () => void) {
  relaunchHandler = handler
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => win.setBackgroundColor(color))
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function defaultBackgroundColor() {
  return novaBackground[tone()]
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  for (const win of BrowserWindow.getAllWindows()) {
    pinchZoomEnabled.set(win, enabled)
    win.webContents.send("pinch-zoom-enabled-changed", enabled)
    if (!enabled && win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  }
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow() {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  const mode = tone()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    title: "NovaClaw",
    icon: iconPath(),
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 12, y: 14 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  allowRendererPermissions(win)
  wireWindowRecovery(win, "main")

  // Never spawn raw Electron child windows: anything the renderer window.opens (an http/https
  // link from agent-drawn HTML, a URL home tile, a stray target=_blank) goes to the user's
  // default browser; everything else is denied. The open-link IPC stays the intended path —
  // this is the defensive net under it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  wireNavigationGuard(win)

  // ⚠️ There used to be an `onBeforeSendHeaders` hook here adding `Access-Control-Allow-Origin: *`
  // to every outgoing REQUEST. Deleted 2026-07-30: ACAO is a RESPONSE header and no step of the
  // Fetch/CORS algorithm reads it on a request, so it never did anything. Proven, not argued —
  // with it disabled and the response override kept, the one cross-origin fetch in the app
  // (novaclaw.app/changelog.json) still read fine in the running dev app over CDP.
  // It came in as copy-paste: `upsertKeyValue` and its `// Reassign old key` / `// Done` comments
  // are verbatim from the usual StackOverflow "fix CORS in Electron" answer.

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders = {} } = details
    addRendererHeaders(details.url, responseHeaders)
    callback({ responseHeaders })
  })

  state.manage(win)
  loadWindow(win, "index.html")
  wireZoom(win)

  win.once("ready-to-show", () => {
    win.show()
  })

  return win
}

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host !== rendererHost) {
      writeLog("protocol", "rejected host", { url: request.url }, "warn")
      return new Response("Not found", { status: 404 })
    }

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      writeLog("protocol", "rejected path", { url: request.url, file }, "warn")
      return new Response("Not found", { status: 404 })
    }

    try {
      const response = await net.fetch(pathToFileURL(file).toString())
      if (response.status >= 400) {
        writeLog(
          "protocol",
          "fetch failed",
          {
            url: request.url,
            file,
            status: response.status,
            statusText: response.statusText,
          },
          "error",
        )
      }
      return addHtmlDocumentHeaders(response, file)
    } catch (error) {
      writeLog("protocol", "fetch error", { url: request.url, file, error }, "error")
      return new Response("Not found", { status: 404 })
    }
  })
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = resolveRendererDevUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL)
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

function wireWindowRecovery(win: BrowserWindow, name: string) {
  let showing = false
  let preloadSettled = false
  let preloadWatchdog: NodeJS.Timeout | undefined
  const sampler = createUnresponsiveSampler(win, name)

  const handle = async (button: string | undefined, wait: boolean) => {
    if (button === "Export Logs") {
      const sampling = sampler.stopAndFlush()
      await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
      if (wait && sampling) sampler.start()
      return true
    }
    if (button === "Relaunch") {
      sampler.stopAndFlush()
      relaunchHandler()
      return false
    }
    if (button === "Quit") {
      sampler.stopAndFlush()
      app.quit()
    }
    return false
  }

  const show = async (message: string, detail: string, wait: boolean) => {
    if (showing || win.isDestroyed()) return
    showing = true
    try {
      while (!win.isDestroyed()) {
        const buttons = wait ? ["Relaunch", "Export Logs", "Keep Waiting"] : ["Relaunch", "Export Logs", "Quit"]
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        if (await handle(buttons[result.response], wait)) continue
        return
      }
    } finally {
      showing = false
    }
  }

  const clearPreloadWatchdog = () => {
    if (preloadWatchdog === undefined) return
    clearTimeout(preloadWatchdog)
    preloadWatchdog = undefined
  }

  const markPreloadReady = () => {
    if (preloadSettled) return
    preloadSettled = true
    clearPreloadWatchdog()
  }

  const reportPreloadFailure = (recovery: { readonly message: string; readonly detail: string }) => {
    if (preloadSettled) return
    preloadSettled = true
    clearPreloadWatchdog()
    void show(recovery.message, recovery.detail, false)
  }

  const failed = (
    event: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    writeLog(
      "window",
      "renderer load failed",
      {
        window: name,
        event,
        errorCode,
        errorDescription,
        validatedURL,
        currentURL: win.webContents.getURL(),
        isMainFrame,
      },
      "error",
    )

    if (!isMainFrame || errorCode === -3) return
    void show(
      "NovaClaw failed to load",
      [`Window: ${name}`, `URL: ${validatedURL}`, `Error: ${errorCode} ${errorDescription}`].join("\n"),
      false,
    )
  }

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-provisional-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog(
      "window",
      "renderer process gone",
      { window: name, currentURL: win.webContents.getURL(), details },
      "error",
    )
    void show(
      "NovaClaw window terminated unexpectedly",
      [`Window: ${name}`, `Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
    )
  })
  win.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, currentURL: win.webContents.getURL() }, "error")
    sampler.start()
    void show("NovaClaw is not responding", "You can relaunch the app, open the logs, or keep waiting.", true)
  })
  win.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, currentURL: win.webContents.getURL() }, "error")
    sampler.stopAndFlush()
  })
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (message.toLowerCase().includes("terminal") || sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", { window: name, level, message, line, sourceId })
    }
  })
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    writeLog("preload", "preload error", { window: name, preloadPath, error }, "error")
    const recovery = preloadFailureRecovery({ window: name, preloadPath, error })
    reportPreloadFailure(recovery)
  })

  // Electron reports a throwing preload, but a hung module evaluation can leave neither that event
  // nor a renderer process fault. The renderer cannot reach an HTML error boundary until this
  // handshake arrives, so the main process owns a bounded native fallback.
  win.webContents.on("ipc-message", (_event, channel) => {
    if (channel === "preload-ready") markPreloadReady()
  })
  preloadWatchdog = setTimeout(() => {
    reportPreloadFailure(
      {
        message: "NovaClaw could not start",
        detail: [
          `Window: ${name}`,
          "The privileged preload bridge did not initialize within 15 seconds.",
          "Relaunch NovaClaw or export the logs for diagnosis.",
        ].join("\n"),
      },
    )
  }, PRELOAD_READY_TIMEOUT_MS)
  win.once("closed", clearPreloadWatchdog)
}

// Document-level headers for renderer HTML served over `nc://`. The CSP is set here AND in
// `addRendererHeaders` on purpose: a `protocol.handle` response and a `webRequest` interception
// are two different seams, only one of which is guaranteed to cover the packaged build, and a
// renderer document that silently loses its policy is exactly the failure this ships to prevent.
// Both write the same constant, and `upsertKeyValue` REPLACES rather than appends, so a request
// that passes through both carries one policy, not two intersecting ones.
/**
 * A build-hashed filename — the hash IS the version, so the URL changes when the bytes do.
 * Stable-named assets (the skin tiles, `Inter.ttf`) must never be `immutable`: that would pin a stale
 * image in the cache for a year with no way to correct it.
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/

function addHtmlDocumentHeaders(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) {
    // 🔴 A `file:` fetch carries NO caching headers, and this handler used to pass non-HTML straight
    // through — so every navigation back to a screen re-read its images off disk and re-decoded them.
    // The home screen is the worst case: ~14 tile PNGs, 476 KB, on a surface the user returns to
    // constantly. The renderer bundle lives inside the app, so it cannot go stale behind our back;
    // what it CAN do is be re-read needlessly.
    //
    // ⚠️ HTML deliberately keeps falling through to the branch below with NO cache-control, because an
    // upgraded app must not serve a cached shell naming chunk files that no longer exist.
    const headers = new Headers(response.headers)
    headers.set(
      "cache-control",
      HASHED_ASSET.test(file) ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    )
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  const headers = new Headers(response.headers)
  // 🔴 NC-SEC-032 — the agent-canvas host is the one document that must NOT get the app policy.
  // Its whole purpose is to carry a different one: `default-src 'none'` plus the inline execution a
  // canvas is made of. Giving it `RENDERER_CSP` here would leave a canvas with the app's own
  // network reach, which is the opposite of what the served document was introduced to achieve.
  if (isHtmlEmbedDocument(file)) {
    headers.set(CSP_HEADER, HTML_EMBED_CSP)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  headers.set(CSP_HEADER, RENDERER_CSP())
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * 🔴 NC-SEC-002 — the main frame may only ever show the app's own renderer.
 *
 * The preload belongs to the webContents, not to the document: any page the main frame reaches
 * inherits `window.api` and with it the filesystem. `setWindowOpenHandler` above covers
 * `window.open`; this covers the other way out, which had no cover at all.
 *
 * ⚠️ Both events. `will-navigate` alone is a guard on the FIRST hop only — a trusted URL that
 * 302s to a foreign origin never fires it, and `will-redirect` is the event that sees the second
 * hop. Guarding one and not the other is the shape of a guard that reads as complete.
 *
 * ⚠️ Neither fires for `loadURL`, `goBack` or in-page hash changes, which is why the app's own
 * boot and its hash routing are untouched by this.
 */
function wireNavigationGuard(win: BrowserWindow) {
  const guard = createNavigationGuard({
    origin: rendererOrigin,
    openExternal: (url) => void shell.openExternal(url),
    log: (message, url) => writeLog("navigation", message, { url }, "warn"),
  })

  win.webContents.on("will-navigate", (event, url) => guard(event, url))
  win.webContents.on("will-redirect", (event, url) => guard(event, url))
}

function allowRendererPermissions(win: BrowserWindow) {
  const webContentsId = win.webContents.id

  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        isTrustedRendererUrl(details.requestingUrl) &&
        webContents.id === webContentsId,
    )
  })
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission)) return false
    if (webContents && webContents.id !== webContentsId) return false
    return isTrustedRendererUrl(details.requestingUrl) || isTrustedRendererUrl(requestingOrigin)
  })
}

function isTrustedRendererUrl(value?: string) {
  return isRendererUrl(value)
}

/**
 * Hosts whose responses need an ACAO injected because they do not send one, and that the renderer
 * legitimately reads cross-origin.
 *
 * ⚠️ This used to be a blanket `*` on EVERY response the renderer session received, and that
 * nullified the instance server's own CORS policy inside the desktop app. The server deliberately
 * allowlists `nc://renderer` and refuses everything else (`packages/server/src/cors.ts`, pinned by
 * `httpapi-cors.test.ts` asserting `https://evil.example` is refused) — and there is a whole
 * `corsVaryFix` middleware keeping `Vary: Origin` honest for that per-origin echo. Overwriting the
 * echo with `*` threw all of that away, including for the `Origin: null` requests an `allow-scripts`
 * sandboxed agent canvas sends.
 *
 * It is narrowed rather than deleted because ONE fetch genuinely depends on it, measured rather than
 * assumed: `https://novaclaw.app/changelog.json` (the What's-new feed, `app/src/context/highlights.tsx`)
 * is served by a third-party static host that sends **no** `Access-Control-Allow-Origin` at all —
 * confirmed by `curl -D -`, whose 404 carries only `Content-Type`. Measured in the running dev app
 * over CDP: with the override the renderer reads it (`status 404, type "cors"`); with the override
 * disabled the same fetch fails `TypeError: Failed to fetch`. So deleting it outright would break
 * What's-new the day that file starts existing.
 *
 * The real fix is upstream — novaclaw.app should send its own ACAO — at which point this list, and
 * this whole function's CORS half, can go.
 */
const ACAO_INJECT_ORIGINS = new Set(["https://novaclaw.app"])

function addRendererHeaders(value: string, headers: Record<string, any>) {
  // Only for the hosts that need it. Every other response — above all the instance server's — keeps
  // whatever ACAO its own policy chose.
  let origin: string | undefined
  try {
    origin = new URL(value).origin
  } catch {
    /* not an absolute URL; no injection */
  }
  if (origin !== undefined && ACAO_INJECT_ORIGINS.has(origin)) {
    upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
  }
  // Same gate the Document-Policy header already uses, and it is the right one: it is true for
  // `nc://renderer/*.html` (packaged) and for `*.html` on the dev-server origin (dev), i.e. for
  // exactly the documents this policy is written for — and never for a remote instance's HTML.
  if (!isRendererUrl(value, true)) return
  // NC-SEC-032, the dev-server half of the same rule. The packaged half is in
  // `addHtmlDocumentHeaders`; this is the path a dev build takes, and a canvas that behaved
  // differently in dev would be a canvas whose containment was never exercised where it is written.
  if (isHtmlEmbedDocument(new URL(value).pathname)) {
    upsertKeyValue(headers, CSP_HEADER, [HTML_EMBED_CSP])
    return
  }
  upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
  upsertKeyValue(headers, CSP_HEADER, [RENDERER_CSP()])
}

/**
 * The trusted renderer origin, read fresh on every call.
 *
 * ⚠️ Not captured at module load. `app.isPackaged` is meaningful from the first tick, but reading
 * it once here would make the trust set a startup snapshot — and this predicate answers questions
 * (may this document hold the preload? may it request a permission?) that arrive throughout the
 * session, so it must ask them of the current process, not of a remembered one.
 */
function rendererOrigin() {
  // Same guard as `loadWindow`: a packaged build must not trust an inherited dev-server origin as a
  // navigation target either. The upstream patch fixed only the load path; this is the second reader.
  return { devUrl: resolveRendererDevUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL) }
}

function isRendererUrl(value?: string, html = false) {
  return isRendererUrlFor(value, rendererOrigin(), html)
}

function wireZoom(win: BrowserWindow) {
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault()
    if (pinchZoomEnabled.get(win)) {
      win.webContents.setZoomFactor(clampZoom(win.webContents.getZoomFactor() + (zoomDirection === "in" ? 0.2 : -0.2)))
      updateZoom(win)
      return
    }
    if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  })
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  win.webContents.send("zoom-factor-changed", win.webContents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, any>, keyToChange: string, value: any) {
  const keyToChangeLower = keyToChange.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === keyToChangeLower) {
      // Reassign old key
      obj[key] = value
      // Done
      return
    }
  }
  // Insert at end instead
  obj[keyToChange] = value
}
