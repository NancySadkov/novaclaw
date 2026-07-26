import { FSUtil } from "@novaclaw/core/fs-util"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("novaclaw-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

/**
 * The "you have reached an API, not a page" response. Deliberately dependency-free and inline: it must work
 * in exactly the situation where the UI bundle is missing.
 */
function apiRootPage() {
  const body = `<!doctype html>
<meta charset="utf-8">
<title>NovaClaw API</title>
<style>
  :root { color-scheme: light dark }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 12vh auto; padding: 0 1.5rem }
  code { background: color-mix(in oklab, currentColor 12%, transparent); padding: .1em .35em; border-radius: .3em }
  .ok { color: #16a34a; font-weight: 600 }
</style>
<h1>NovaClaw API</h1>
<p class="ok">This server is running correctly.</p>
<p>
  It serves the JSON API only — there is no page here. You are seeing this instead of
  <code>{"error":"Not Found"}</code> because a browser asked for <code>/</code>.
</p>
<p>
  <strong>Looking for the app?</strong> Start the <code>webapp</code> dev server and open
  <a href="http://localhost:3000">http://localhost:3000</a>. It talks to this one.
</p>
<p>To check this server directly, try <code>/api/session</code> or <code>/api/recipe</code>.</p>`
  return HttpServerResponse.text(body, { headers: { "content-type": "text/html; charset=utf-8" } })
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

// The packaged binary bakes the web UI in via novaclaw-web-ui.gen.ts. Without it
// (dev/tests, or NOVACLAW_DISABLE_EMBEDDED_WEB_UI) unmatched paths are a plain 404 —
// there is deliberately no remote fallback: the upstream design proxied its hosted
// web app here, which both phones home and breaks offline.
export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname
    // No embedded UI (running from source, or deliberately disabled). Anyone who points a BROWSER at the
    // API root then gets a bare `{"error":"Not Found"}`, which reads as a broken server rather than a
    // correctly-running API with no page to show — it has cost real debugging time more than once. Answer
    // the root with a page that says what this is and where the app actually lives. Any other path keeps
    // the JSON 404: only `/` is ambiguous enough to be worth explaining.
    if (!embeddedWebUI) return path === "/" ? apiRootPage() : notFound()
    return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)
  })
}
