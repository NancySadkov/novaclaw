/**
 * Where the renderer window is allowed to GO.
 *
 * ## The hole this closes (NC-SEC-002)
 *
 * `webPreferences.preload` is a property of the webContents, not of the document: whatever the main
 * frame is showing gets `window.api`, the IPC bridge to the main process — which reaches the
 * filesystem, the shell environment, the log directory and the sidecar. So the preload's blast
 * radius is exactly "every origin the main frame can reach", and until this module that set was
 * unbounded. One `window.location = "https://…"` from anywhere in the renderer — a markdown link
 * that escaped the open-link IPC, an agent-drawn anchor, a redirect on a URL the user typed into
 * remote-access mode — and a remote page owned the bridge.
 *
 * ⚠️ The renderer CSP does not cover this and says so: `form-action 'none'` stops FORMS navigating
 * and `frame-ancestors 'none'` stops the app being embedded, but no CSP directive constrains where
 * a document may navigate ITSELF (`navigate-to` was specified and then dropped, and Chrome never
 * shipped it). `setWindowOpenHandler` does not cover it either — that is `window.open` and
 * `target=_blank`, a different event entirely. Top-frame navigation had no guard at all.
 *
 * ⚠️ The predicate was already written. `windows.ts` had `isRendererUrl` deciding which documents
 * get the CSP and which may request permissions, and `renderer-url.ts` documented it as "the
 * navigation allowlist" — a rule describing an enforcement that did not exist. It lives here now,
 * with the navigation guard built ON it rather than beside it, so the two can never disagree.
 */

/** The privileged scheme the packaged renderer is served from — `windows.ts` registers it. */
export const RENDERER_PROTOCOL = "nc"
export const RENDERER_HOST = "renderer"

/**
 * The trusted renderer origin, resolved per call rather than captured.
 *
 * `devUrl` must come from `resolveRendererDevUrl`, never from `process.env` directly: a PACKAGED
 * build that inherited `ELECTRON_RENDERER_URL` from another Electron dev shell would otherwise
 * trust that foreign origin here too.
 */
export type RendererOrigin = {
  readonly devUrl: string | undefined
}

/**
 * Is this URL the app's own renderer?
 *
 * @param html restrict to `*.html` documents — for the response-header pass, which is about
 *   documents rather than about origins. Navigation does NOT set it: the SPA may legitimately
 *   navigate within its own origin to a path that is not a `.html` file.
 */
export function isRendererUrl(value: string | undefined, origin: RendererOrigin, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${RENDERER_PROTOCOL}:` && url.host === RENDERER_HOST) return true
  const { devUrl } = origin
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}

/**
 * What to do with a main-frame navigation.
 *
 * - `allow` — the app's own renderer, the only origin the preload may be exposed to.
 * - `external` — a web page: hand it to the user's default browser, exactly as
 *   `setWindowOpenHandler` already does for `window.open`. Clicking a link should still open it;
 *   the point is that it opens somewhere WITHOUT the bridge.
 * - `block` — anything else, silently. `file:`, `data:`, `javascript:`, a foreign custom scheme,
 *   or `nc://` on a host that is not ours.
 *
 * ⚠️ `external` is not a softer `block`. It is the same verdict — the navigation is refused — plus
 * a place to put the URL. Both return `preventDefault`; only the side effect differs.
 */
export type NavigationVerdict = "allow" | "external" | "block"

export function classifyNavigation(target: string, origin: RendererOrigin): NavigationVerdict {
  if (isRendererUrl(target, origin)) return "allow"
  // ⚠️ Parsed, not regex-matched, because the `external` arm hands this string to
  // `shell.openExternal` — the one branch here with a side effect outside the app. `/^https?:/i`
  // answers a question about the first few CHARACTERS; `URL.canParse` answers the question we
  // actually have, which is whether this is a web URL at all.
  if (!URL.canParse(target)) return "block"
  const { protocol } = new URL(target)
  return protocol === "http:" || protocol === "https:" ? "external" : "block"
}

/**
 * The `will-navigate` / `will-redirect` handler.
 *
 * Built here rather than inline in `windows.ts` for the usual reason in this directory: what is
 * left at the call site is two `.on(...)` lines, and everything with a decision in it can be
 * exercised without an Electron process. Its dependencies are passed in, not imported, so the test
 * can watch what it DOES — refuse, hand off, log — instead of only what it returns.
 *
 * ⚠️ `origin` is a function, not a value. The trust set depends on `app.isPackaged` and the
 * environment; capturing it at wiring time would freeze a startup snapshot into a guard that has to
 * answer for the whole session.
 */
export function createNavigationGuard(deps: {
  origin: () => RendererOrigin
  openExternal: (url: string) => void
  log: (message: string, url: string) => void
}) {
  return (event: { preventDefault: () => void }, target: string) => {
    const verdict = classifyNavigation(target, deps.origin())
    if (verdict === "allow") return
    event.preventDefault()
    // ⚠️ Logged in BOTH refusing branches, not only the blocked one. From inside the app a link
    // that opened in the browser and a scheme that went nowhere look identical, and that
    // difference is exactly what somebody reading a report of "it just did nothing" needs.
    deps.log(`refused main-frame navigation (${verdict})`, target)
    if (verdict === "external") deps.openExternal(target)
  }
}
