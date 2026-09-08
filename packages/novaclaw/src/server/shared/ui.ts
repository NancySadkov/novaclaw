import { HTML_EMBED_CSP, isHtmlEmbedDocument } from "@novaclaw/schema/html-embed"
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

/**
 * The policy for an HTML document this server serves.
 *
 * 🔴 NC-SEC-032 — the embed bootstrap gets its OWN policy, not the app's. The app policy has no
 * `script-src 'unsafe-inline'`, and an agent canvas is inline by construction, so under the app
 * policy canvases simply never ran on this surface. `csp.ts` on the desktop side warns about
 * exactly that failure ("silently kills every HTML canvas, and no test outside this file would
 * notice") — and this surface had been shipping it.
 *
 * ⚠️ Serving it as a real document is what makes this possible at all. `srcdoc`, `data:` and
 * `blob:` children inherit the embedder's policy container; a network-delivered document does not,
 * so the embed's policy is the embed's own. Measured in Chromium, both directions.
 *
 * ⚠️ The app policy is NOT loosened to accommodate the canvas. This surface is the one that is
 * actually network-exposed (remote access), and widening its `script-src` to match the local
 * desktop one would be fixing the safer surface by damaging the more dangerous one.
 */
export function cspForHtml(body: string, pathname = "") {
  if (isHtmlEmbedDocument(pathname)) return HTML_EMBED_CSP
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

/**
 * A build-hashed filename, e.g. `KaTeX_AMS-Regular-BQhdFMY1.woff2` or `index-a1b2c3d4.js`.
 *
 * Only these may be `immutable`: the hash IS the version, so the URL changes when the bytes do. The
 * skin tiles (`assets/skin/tiles/notes.png`), `Inter.ttf` and friends ship under STABLE names, and
 * marking one of those immutable would pin a stale image in every client's cache for a year with no
 * way to push a correction. `dist/assets` genuinely contains both kinds — that is why this is a
 * predicate and not a directory rule.
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/

/**
 * Caching for the embedded UI, in three tiers.
 *
 * 🔴 **Before this, the only header was `content-type`** — no `Cache-Control`, no validator. A response
 * with neither gives the browser nothing to revalidate against and no freshness to trust, so repeat
 * navigations re-request 3.5 MB of `public/assets` (476 KB of it home-screen tiles) and the server
 * re-reads every one from disk with a fresh `fs.readFile`. Switching back to a screen you already
 * visited paid full price.
 *
 * ⚠️ **HTML must stay revalidated, and this is the tier that would be a bug to get wrong.** The
 * document names the hashed chunks; caching it means an upgraded instance serves a shell pointing at
 * chunk filenames that no longer exist, and the app dead-ends on a screen nobody can clear. `no-cache`
 * here does not mean "do not store" — it means "always ask" — so the ETag below still turns the ask
 * into a 304 with no body.
 */
function cacheControlFor(file: string, mime: string) {
  if (mime.startsWith("text/html")) return "no-cache"
  if (HASHED_ASSET.test(file)) return "public, max-age=31536000, immutable"
  // Stable-named static assets: let the client hold them for a session, then revalidate against the
  // ETag. A tile that changes in an upgrade is corrected within the hour rather than within a year.
  return "public, max-age=3600, must-revalidate"
}

interface EmbeddedAsset {
  readonly body: Uint8Array
  readonly etag: string
}

// The generated asset map is immutable for the life of the process. Cache by that map's identity,
// so a second request does not re-read or re-hash the same embedded bytes from disk.
const embeddedAssets = new WeakMap<Record<string, string>, Map<string, EmbeddedAsset>>()

function embeddedUIResponse(file: string, asset: EmbeddedAsset, ifNoneMatch?: string) {
  const mime = FSUtil.mimeType(file)
  const { body, etag } = asset
  if (ifNoneMatch && ifNoneMatch.split(",").some((candidate) => candidate.trim() === etag)) {
    return HttpServerResponse.empty({
      status: 304,
      headers: new Headers({ etag, "cache-control": cacheControlFor(file, mime) }),
    })
  }
  const headers = new Headers({ "content-type": mime, etag, "cache-control": cacheControlFor(file, mime) })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body), file))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
  ifNoneMatch?: string,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  let assets = embeddedAssets.get(embeddedWebUI)
  if (!assets) {
    assets = new Map()
    embeddedAssets.set(embeddedWebUI, assets)
  }
  const cached = assets.get(file)
  if (cached) return Effect.succeed(embeddedUIResponse(file, cached, ifNoneMatch))

  return fs.readFile(file).pipe(
    Effect.map((body) => {
      // A STRONG validator over the bytes we already hold in memory. The embedded UI is baked into
      // the binary, so mtime is a property of the install rather than of the content.
      const asset = {
        body,
        etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
      }
      assets!.set(file, asset)
      return embeddedUIResponse(file, asset, ifNoneMatch)
    }),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

// The packaged binary bakes the web UI in via novaclaw-web-ui.gen.ts. Without it
// (dev/tests, or NOVACLAW_DISABLE_EMBEDDED_WEB_UI) unmatched paths are a plain 404 —
// there is deliberately no remote fallback: the upstream design proxied its hosted
// web app here, which both phones home and breaks offline.
export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: {
    fs: FSUtil.Interface
    disableEmbeddedWebUi: boolean
    embeddedWebUI?: Record<string, string>
  },
) {
  return Effect.gen(function* () {
    const embeddedWebUI =
      services.embeddedWebUI ?? (yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi)))
    const path = new URL(request.url, "http://localhost").pathname
    // No embedded UI (running from source, or deliberately disabled). Anyone who points a BROWSER at the
    // API root then gets a bare `{"error":"Not Found"}`, which reads as a broken server rather than a
    // correctly-running API with no page to show — it has cost real debugging time more than once. Answer
    // the root with a page that says what this is and where the app actually lives. Any other path keeps
    // the JSON 404: only `/` is ambiguous enough to be worth explaining.
    if (!embeddedWebUI) return path === "/" ? apiRootPage() : notFound()
    // Threaded through so a repeat visit can be answered 304 with no body at all.
    return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI, request.headers["if-none-match"])
  })
}
